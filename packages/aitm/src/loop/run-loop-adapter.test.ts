// Unit coverage for the production WorkLoop wiring. Every external dependency (Planner,
// Orchestrator, InPlaceCheckout, GitHubClient, MCP, StateStore) is driven through the adapter's
// seams so all four WorkLoopResult branches — success, awaiting-pr, blocked, session-cap —
// are reachable without spawning subagents, git, or `gh`. The integration suite covers the
// real stack end-to-end.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AUTONOMY_CONTRACT_TEXT,
  backgroundProcessTools,
  COMMUNICATION_CONTRACT_TEXT,
  SYSTEM_REMINDER_CONTRACT,
} from '@developerz.ai/ai-claude-compat';
import type { LanguageModelUsage, ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { RunLoopInput } from '../composition/run-input.ts';
import { Credentials } from '../credentials/credentials.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';
import { GitHubClient } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { UsageTracker } from '../observability/usage-tracker.ts';
import { type ModelLimitsLookup, ModelNotFound } from '../openrouter/model-limits.ts';
import type { RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import { type TranscriptRecorder, TranscriptStore } from '../state/transcript-store.ts';
import type { WorkerResult } from '../subagents/worker.ts';
import {
  type AdapterStatePort,
  createRollingContextAccumulator,
  defaultMakeOrchestrator,
  describeError,
  harnessContextBlock,
  makeBudgetCheck,
  type PlanGroupsOutcome,
  persistRollingContext,
  RAW_STYLE_MAX_CHARS,
  type RunLoopAdapterSeams,
  recordStepDeltas,
  reminderAgentSystemPrompt,
  resolveStyleContents,
  retryProgressMessage,
  runLoopAdapter,
  runProgressReminder,
  runStepContextLine,
  selfReviewVerifyCommand,
  webSearchProviderOptions,
} from './run-loop-adapter.ts';
import type { CheckoutHome, WorkLoopGithub, WorkLoopOrchestrator } from './work-loop.ts';

// ---- Fixtures --------------------------------------------------------------

function group(id: string, overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id,
    title: id,
    tasks: [{ id: 'do-thing', text: 'do thing', complexity: 'normal', done: false }],
    dependsOn: [],
    branch: `aitm/${id}`,
    pr: null,
    status: 'pending',
    ...overrides,
  };
}

function baseState(prGroups: PrGroup[] = []): RunState {
  return {
    status: 'planning',
    prGroups,
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'run-1',
    provider: 'openrouter',
    model: 'm',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 2,
    },
  };
}

// In-memory state port. read() returns the current snapshot; update() applies the mutator.
function makeState(seed: PrGroup[] = []): { state: AdapterStatePort; current: () => RunState } {
  let current = baseState(seed);
  const state: AdapterStatePort = {
    read: async () => current,
    update: async (mutator) => {
      current = mutator(current);
      return current;
    },
  };
  return { state, current: () => current };
}

function delivery(): WorkerDelivery {
  return {
    branch: 'aitm/x',
    draftCommitMessage: 'feat: x',
    changes: [{ path: 'a.ts', kind: 'create', summary: 'created a' }],
    progressEntries: ['- did x'],
  };
}

function pr(number: number): PullRequest {
  return {
    number,
    state: 'OPEN',
    url: `https://github.com/o/r/pull/${number}`,
    headRefName: 'aitm/x',
    baseRefName: 'main',
  };
}

// Orchestrator stub whose Worker outcome is configurable; finalizeCommit / openPr / addressReviews
// are inert so the loop advances to the merge/awaiting state.
function makeOrchestrator(
  config: { worker?: WorkerResult; prNumber?: number } = {},
): WorkLoopOrchestrator {
  return {
    runWorker: async () => config.worker ?? { kind: 'ok', delivery: delivery() },
    finalizeCommit: async () => 'sha',
    openPr: async () => pr(config.prNumber ?? 1),
    runCiFix: async () => ({ kind: 'ok' }),
    addressReviews: async () => ({ kind: 'ok' }),
  };
}

function makeGithub(): WorkLoopGithub {
  return {
    defaultBranch: async () => 'main',
    waitForChecks: async () => ({ state: 'success', failedChecks: [] }),
    listUnresolvedThreads: async (): Promise<ReviewThread[]> => [],
    mergePr: async () => {},
  };
}

function makeCheckout(): CheckoutHome {
  return {
    acquire: async (groupId, branch) => ({ groupId, branch, path: `/tmp/wt/${groupId}` }),
    release: async () => {},
  };
}

function makeInput(
  overrides: { autoMerge?: boolean; maxSessions?: number | null; concurrency?: number } = {},
): RunLoopInput {
  const resolved: RunLoopInput['resolved'] = {
    openrouterApiKey: 'k',
    apiKeySource: 'env',
    models: { generic: 'g', smart: 's', coding: 'c', fast: 'f' },
    maxPrs: 5,
    maxSessions: overrides.maxSessions ?? null,
    autoMerge: overrides.autoMerge ?? true,
    mergeMethod: 'squash',
    stylePath: null,
    logLevel: 'info',
    concurrency: overrides.concurrency ?? 2,
    mcpServers: {},
    mcpServerSources: {},
  };
  // Real instances with side-effect-free constructors. The injected seams stand in for these
  // during the loop, so their methods (network/git/fs) are never actually exercised here.
  return {
    cwd: '/tmp/repo',
    goal: 'noop goal',
    criteria: undefined,
    resolved,
    credentials: new Credentials(resolved),
    agentConfig: { flavor: 'claude', path: 'CLAUDE.md', contents: '# style' },
    state: new StateStore('/tmp/aitm-adapter-test-unused'),
    github: new GitHubClient('/tmp/repo'),
  };
}

// Seams that fully isolate the loop from the outside world. Override per test.
function seams(over: Partial<RunLoopAdapterSeams> = {}): RunLoopAdapterSeams {
  // Empty state by default so the planner path runs; override `state` to test resume.
  const { state } = makeState();
  return {
    planGroups: async (): Promise<PlanGroupsOutcome> => ({ kind: 'ok', groups: [group('only')] }),
    // The goal assessor is outside-world too: stub it complete so a test that says nothing about
    // waves runs exactly one, and only the wave tests below opt into a second.
    assessGoal: async () => ({ complete: true, remaining: '', rationale: 'stub' }),
    makeOrchestrator: () => makeOrchestrator(),
    makeCheckout: () => makeCheckout(),
    makeGithub: () => makeGithub(),
    state,
    ...over,
  };
}

// ---- Branch: blocked (planner) ---------------------------------------------

test('planner blocked → WorkLoopResult blocked, loop never starts', async () => {
  let orchestratorBuilt = false;
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      planGroups: async () => ({ kind: 'blocked', reason: 'cannot parse goal' }),
      makeOrchestrator: () => {
        orchestratorBuilt = true;
        return makeOrchestrator();
      },
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /cannot parse goal/);
  assert.equal(orchestratorBuilt, false, 'orchestrator must not build when planning blocks');
});

test('planner error → blocked carrying the error', async () => {
  const result = await runLoopAdapter(
    makeInput(),
    seams({ planGroups: async () => ({ kind: 'error', error: 'schema mismatch' }) }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /planner error: schema mismatch/);
});

test('planner returns zero groups → blocked', async () => {
  const result = await runLoopAdapter(
    makeInput(),
    seams({ planGroups: async () => ({ kind: 'ok', groups: [] }) }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /no PR groups/);
});

test('fresh plan that fails validation → blocked, and is never persisted as resumable state', async () => {
  // A structurally-invalid plan (here: a dangling dependency) must be rejected BEFORE it is written
  // to state. Persisting it first would strand every later run on the resume branch, re-rejecting the
  // same plan instead of replanning — so prGroups must stay empty.
  const { state, current } = makeState();
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      state,
      planGroups: async () => ({ kind: 'ok', groups: [group('a', { dependsOn: ['ghost'] })] }),
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /unknown group 'ghost'/);
  assert.equal(current().prGroups.length, 0, 'rejected plan must not become resumable state');
});

// ---- Branch: success -------------------------------------------------------

test('autoMerge success path → success; plan persisted to state', async () => {
  const { state, current } = makeState();
  const result = await runLoopAdapter(
    makeInput({ autoMerge: true }),
    seams({
      state,
      planGroups: async () => ({ kind: 'ok', groups: [group('only')] }),
      makeOrchestrator: () => makeOrchestrator({ prNumber: 7 }),
    }),
  );
  assert.equal(result.kind, 'success');
  // The plan was written into state before the loop ran, and the group reached 'merged'.
  const s = current();
  assert.equal(s.status, 'working');
  assert.equal(s.prGroups[0]?.id, 'only');
  assert.equal(s.prGroups[0]?.status, 'merged');
});

// ---- Branch: awaiting-pr ---------------------------------------------------

test('autoMerge=false → awaiting-pr with the opened PR number', async () => {
  const result = await runLoopAdapter(
    makeInput({ autoMerge: false }),
    seams({
      planGroups: async () => ({ kind: 'ok', groups: [group('only')] }),
      makeOrchestrator: () => makeOrchestrator({ prNumber: 17 }),
    }),
  );
  assert.equal(result.kind, 'awaiting-pr');
  if (result.kind === 'awaiting-pr') assert.deepEqual(result.prs, [17]);
});

// ---- Branch: blocked (worker) ----------------------------------------------

test('worker blocked on a group → WorkLoopResult blocked with the reason', async () => {
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      planGroups: async () => ({ kind: 'ok', groups: [group('only')] }),
      makeOrchestrator: () =>
        makeOrchestrator({ worker: { kind: 'blocked', reason: 'cannot edit' } }),
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /only/);
    assert.match(result.reason, /cannot edit/);
  }
});

// ---- Branch: session-cap ---------------------------------------------------

test('session cap reached across groups → session-cap', async () => {
  const { state } = makeState();
  const result = await runLoopAdapter(
    makeInput({ autoMerge: true, maxSessions: 1, concurrency: 1 }),
    seams({
      state,
      planGroups: async () => ({ kind: 'ok', groups: [group('g1'), group('g2')] }),
      makeOrchestrator: () => makeOrchestrator({ prNumber: 3 }),
    }),
  );
  assert.equal(result.kind, 'session-cap');
});

// ---- Resume path -----------------------------------------------------------

test('resume: prior prGroups in state skip planning entirely', async () => {
  const { state } = makeState([group('done', { status: 'merged', pr: 9 })]);
  let plannerCalled = false;
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      state,
      planGroups: async () => {
        plannerCalled = true;
        return { kind: 'ok', groups: [group('fresh')] };
      },
    }),
  );
  assert.equal(plannerCalled, false, 'planner must not run when state already has prGroups');
  // All groups already merged → graph complete → success with no work.
  assert.equal(result.kind, 'success');
});

test('resume: an interrupted waiting-ci group is rescheduled through the real adapter and merged', async () => {
  // The production resume path, end-to-end through runLoopAdapter — no hand-reset of status. A run
  // that crashed after pr-open persists the group at stage 'waiting-ci' with coarse status
  // 'awaiting-pr', which PlanGraph.ready() will NOT schedule. The adapter must normalize it back to
  // 'pending' (preserving stage + pr) so the loop resumes at waiting-ci, re-running neither the
  // Worker nor openPr. This is the true coverage the resume-flow integration test could not give
  // (it stubbed the loop and forced status itself).
  const resuming = group('resuming', {
    status: 'awaiting-pr',
    stage: 'waiting-ci',
    pr: 42,
    tasks: [{ id: 'do-thing', text: 'do thing', complexity: 'normal', done: true }],
  });
  const { state, current } = makeState([resuming]);

  let workerCalls = 0;
  let openPrCalls = 0;
  let waitForChecksCalls = 0;
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async () => {
      workerCalls++;
      return { kind: 'ok', delivery: delivery() };
    },
    finalizeCommit: async () => 'sha',
    openPr: async () => {
      openPrCalls++;
      return pr(42);
    },
    runCiFix: async () => ({ kind: 'ok' }),
    addressReviews: async () => ({ kind: 'ok' }),
  };
  const github: WorkLoopGithub = {
    defaultBranch: async () => 'main',
    waitForChecks: async () => {
      waitForChecksCalls++;
      return { state: 'success', failedChecks: [] };
    },
    listUnresolvedThreads: async (): Promise<ReviewThread[]> => [],
    mergePr: async () => {},
  };

  const result = await runLoopAdapter(
    makeInput({ autoMerge: true }),
    seams({
      state,
      makeOrchestrator: () => orchestrator,
      makeGithub: () => github,
      planGroups: async () => {
        throw new Error('planner must not run on resume');
      },
    }),
  );

  assert.equal(result.kind, 'success');
  assert.equal(workerCalls, 0, 'Worker not re-run when resuming at waiting-ci');
  assert.equal(openPrCalls, 0, 'openPr not re-called when resuming at waiting-ci');
  assert.equal(waitForChecksCalls, 1, 'CI polled once for the persisted PR');
  const s = current();
  assert.equal(s.prGroups[0]?.status, 'merged', 'group advances to merged on resume');
  assert.equal(s.prGroups[0]?.stage, 'merged');
});

// ---- Background bash lifecycle (issue #103) --------------------------------

// Poll until `predicate` holds or the budget runs out — avoids racing on async process-exit events.
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('runLoopAdapter: reaps leftover background processes at run end (issue #103)', async () => {
  // A dev server a worker/reviewer started and never stopped: still running when the run ends. The
  // adapter owns the manager, so its finally must killAll() it — otherwise the process outlives aitm.
  const bg = backgroundProcessTools({ cwd: process.cwd() });
  const leftover = bg.manager.start('sleep 30');
  assert.equal(leftover.running, true, 'leftover process started');
  try {
    await runLoopAdapter(makeInput(), seams({ makeBackground: () => bg }));
    await until(() => bg.manager.list().every((p) => !p.running));
    assert.equal(
      bg.manager.list().every((p) => !p.running),
      true,
      'every leftover background process reaped at run end',
    );
  } finally {
    bg.manager.killAll('SIGKILL');
  }
});

// ---- Default orchestrator bridge: no MCP → local fs-tools fallback ----------

test('harnessContextBlock: a byte-stable single envelope — currentDate only, no style/progress (slice 04 §4)', () => {
  const block = harnessContextBlock();
  assert.equal((block.match(/<system-reminder>/g) ?? []).length, 1, 'single envelope');
  assert.match(block, /# currentDate\n\d{4}-\d{2}-\d{2}/);
  assert.match(block, /may or may not be relevant/);
  // The style digest lives only in the system prompt (buildRolePrompt) — never repeated here (#231).
  assert.equal(block.includes('# claudeMd'), false, 'no duplicate style section');
  // The volatile Step N/M position is NOT in the leading block — it rides runProgressReminder, so the
  // cacheable prompt prefix can't be invalidated per step (slice 04 §4).
  assert.equal(block.includes('# runProgress'), false, 'no progress section in the leading block');
  // No argument to vary → byte-identical every call (the point: a stable, cacheable prompt prefix).
  assert.equal(block, harnessContextBlock(), 'byte-identical across calls');
});

test('runProgressReminder: the run position rides a standalone TRAILING <system-reminder> (slice 04 §4)', () => {
  const block = runProgressReminder({ phase: 'working', unit: 'group', index: 2, total: 5 });
  assert.equal((block.match(/<system-reminder>/g) ?? []).length, 1, 'one trailing envelope');
  assert.match(block, /# runProgress\nStep 2 of 5 — working/);
  // Phase-only (planning, before any group counter exists) still reports position.
  assert.match(runProgressReminder({ phase: 'planning' }), /# runProgress\nPhase: planning/);
  // Nothing to report → empty string, so appendReminderBlock leaves the prompt untouched.
  assert.equal(runProgressReminder({}), '', 'no position → no trailing block');
});

test('stable cache-friendly prefix: leading block + system prompt byte-identical across steps; only the trailing progress moves (slice 04 §4)', () => {
  const style = 'STYLE-DIGEST-SENTINEL';
  const sysInput = {
    style,
    roleGuidance: 'You are the Worker.',
    cwd: '/repo',
    maxSteps: 40,
    modelId: 'anthropic/claude-sonnet-4',
  };
  // The two pieces of the cacheable first-message prefix take NO step input, so they are identical no
  // matter where the run is — the invariant this task locks in. Built in immediate succession (both
  // fully synchronous), so the day-granular date is the same for both.
  const prefixAtStepA = `${reminderAgentSystemPrompt(sysInput)}\n\n${harnessContextBlock()}`;
  const prefixAtStepB = `${reminderAgentSystemPrompt(sysInput)}\n\n${harnessContextBlock()}`;
  assert.equal(prefixAtStepA, prefixAtStepB, 'the prompt prefix is byte-identical across calls');

  // The style/prefix payload appears EXACTLY once — only in the system prompt, never echoed by the
  // per-message context block (no double-billing, nothing step-dependent near it).
  assert.equal(
    (prefixAtStepA.match(new RegExp(style, 'g')) ?? []).length,
    1,
    'the style digest appears exactly once in the prefix',
  );
  assert.equal(prefixAtStepA.includes('# runProgress'), false, 'no run position in the prefix');

  // Only the trailing reminder reflects the live position, and it differs step to step — so it lands
  // AFTER the cached prefix, never inside it.
  const trailA = runProgressReminder({ phase: 'working', index: 3, total: 40 });
  const trailB = runProgressReminder({ phase: 'working', index: 4, total: 40 });
  assert.notEqual(trailA, trailB, 'the trailing progress tracks the live position');
  assert.match(trailA, /Step 3 of 40 — working/);
});

test('resolveStyleContents: distilled digest wins and is left uncapped (already bounded)', () => {
  const digest = 'd'.repeat(RAW_STYLE_MAX_CHARS + 500);
  const style = resolveStyleContents({
    styleDigest: digest,
    agentConfig: { flavor: 'claude', path: 'CLAUDE.md', contents: 'ignored raw file', sources: [] },
  });
  assert.equal(style, digest, 'the digest is trusted as bounded — not re-capped');
});

test('resolveStyleContents: unbounded raw fallback is capped with a signposted marker', () => {
  const raw = 'r'.repeat(RAW_STYLE_MAX_CHARS + 2000);
  const style = resolveStyleContents({
    agentConfig: { flavor: 'claude', path: 'CLAUDE.md', contents: raw, sources: [] },
  });
  assert.ok(style.length <= RAW_STYLE_MAX_CHARS, 'never exceeds the cap');
  assert.ok(style.endsWith('[style truncated]'), 'truncation is signposted to the model');
  assert.ok(style.startsWith('rrr'), 'the head — where house-style rules lead — is kept');
});

test('resolveStyleContents: raw fallback under the cap is returned verbatim', () => {
  const raw = '# Coding Style\n- single quotes only';
  const style = resolveStyleContents({
    agentConfig: { flavor: 'claude', path: 'CLAUDE.md', contents: raw, sources: [] },
  });
  assert.equal(style, raw, 'short style files are untouched');
});

test('runStepContextLine: counter → "Step N of M — phase"; phase-only → "Phase: x"; empty → ""', () => {
  assert.equal(
    runStepContextLine({ phase: 'working', index: 3, total: 38 }),
    'Step 3 of 38 — working',
  );
  assert.equal(runStepContextLine({ phase: 'planning' }), 'Phase: planning');
  assert.equal(runStepContextLine({ index: 1, total: 4 }), 'Step 1 of 4');
  assert.equal(runStepContextLine({}), '');
});

test('reminderAgentSystemPrompt: block pipeline + provenance contract (issues #105/#106)', () => {
  const prompt = reminderAgentSystemPrompt({
    style: '# style',
    roleGuidance: 'You are the Planner.',
    cwd: '/repo',
    modelId: 'anthropic/claude-sonnet-4',
  });
  assert.match(prompt, /# style/, 'carries the style payload');
  assert.match(prompt, /You are the Planner\./, 'carries the role guidance');
  assert.ok(prompt.includes(SYSTEM_REMINDER_CONTRACT), 'carries the system-reminder contract');
  // #105: the always-on behavioral contracts are woven into every main-loop subagent prompt.
  assert.ok(prompt.includes(COMMUNICATION_CONTRACT_TEXT), 'carries the communication contract');
  assert.ok(prompt.includes(AUTONOMY_CONTRACT_TEXT), 'carries the autonomy contract');
  assert.doesNotMatch(
    prompt,
    /budget of/,
    'no step-budget reminder — agents run until they submit',
  );
  assert.match(prompt, /anthropic\/claude-sonnet-4/, 'self-identifies the routed model');
});

// ---- compaction wiring (issue #102) ----------------------------------------

// A worker model that submits an empty FileManifest on its first step → the worker blocks without
// running editors or git, so driving the real bridge stays fast and side-effect-free.
function emptyManifestModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'submit-0',
          toolName: 'submit',
          input: JSON.stringify({ files: [], draftCommitMessage: 'noop' }),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
        totalTokens: 2,
      },
      warnings: [],
    }),
  });
}

test('defaultMakeOrchestrator constructs the Compactor and wires it into the stage-machine worker (issue #102)', async () => {
  const model = emptyManifestModel();
  const rolesSeen: string[] = [];
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: (role: string) => {
      rolesSeen.push(role);
      return 'openai/gpt-5';
    },
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const mcp = {
    toolsForRole: () => ({}),
    toolSurfaceForRole: () => ({ direct: {}, deferred: {} }),
  };
  const input = {
    cwd: '/tmp/adapter-compaction',
    resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null },
    credentials,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    github: {},
    goal: 'g',
    criteria: undefined,
    branch: undefined,
    state: {},
  };

  // Constructing the bridge builds OpenRouterClient + ModelLimitsRegistry + Compactor (lazily, no
  // network) — proving they are live in the production path, not dead exports.
  const orch = defaultMakeOrchestrator({
    input,
    mcp,
    rollingContext: '',
    state: {},
    stepCounter: () => undefined,
  } as never);
  assert.equal(typeof orch.runWorker, 'function');

  const res = await orch.runWorker({
    group: group('core'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  assert.equal(res.kind, 'blocked'); // empty manifest → blocked, but the wiring already ran
  assert.ok(
    rolesSeen.includes('worker'),
    'buildCompactionStep queried the worker-tier model id → the worker received compaction wiring',
  );
});

test("defaultMakeOrchestrator.runWorker: the group's acceptance check reaches the Coordinator", async () => {
  // worker.ts renders the group title + task text into its manifest prompt, never PrGroup.acceptance
  // — so the check rides the role guidance the adapter composes. Without this the Planner's check is
  // persisted and then never read by anyone who could satisfy it.
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (sent === '') sent = JSON.stringify(options.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-0',
            toolName: 'submit',
            input: JSON.stringify({ files: [], draftCommitMessage: 'noop' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
          totalTokens: 2,
        },
        warnings: [],
      };
    },
  });
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const orch = defaultMakeOrchestrator({
    input: {
      cwd: '/tmp/adapter-acceptance',
      resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null },
      credentials,
      agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
      github: {},
      goal: 'g',
      criteria: undefined,
      branch: undefined,
      state: {},
    },
    mcp: { toolsForRole: () => ({}), toolSurfaceForRole: () => ({ direct: {}, deferred: {} }) },
    rollingContext: '',
    state: {},
    stepCounter: () => undefined,
  } as never);
  await orch.runWorker({
    group: group('core', { acceptance: 'bun test src/auth passes and POST /login sets a cookie' }),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  assert.match(sent, /Acceptance check for this PR group/);
  assert.match(sent, /bun test src\/auth passes and POST \/login sets a cookie/);
});

test('defaultMakeOrchestrator.runWorker: a group with no acceptance check adds no block', async () => {
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (sent === '') sent = JSON.stringify(options.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-0',
            toolName: 'submit',
            input: JSON.stringify({ files: [], draftCommitMessage: 'noop' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
          totalTokens: 2,
        },
        warnings: [],
      };
    },
  });
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const orch = defaultMakeOrchestrator({
    input: {
      cwd: '/tmp/adapter-acceptance-legacy',
      resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null },
      credentials,
      agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
      github: {},
      goal: 'g',
      criteria: undefined,
      branch: undefined,
      state: {},
    },
    mcp: { toolsForRole: () => ({}), toolSurfaceForRole: () => ({ direct: {}, deferred: {} }) },
    rollingContext: '',
    state: {},
    stepCounter: () => undefined,
  } as never);
  await orch.runWorker({
    group: group('core'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  assert.doesNotMatch(sent, /Acceptance check for this PR group/);
});

test('defaultMakeOrchestrator.runWorker: threads resolved.subagentLimit into the worker input (issue #189)', async () => {
  // The fan-out honors `input.subagentLimit` — that BEHAVIOR is covered by
  // worker.test.ts ('the editor fanout honors the concurrency cap'). Here we assert the link the fix
  // restores: the run-loop adapter passes the *resolved* cap into the worker input. Captured
  // deterministically through the workerRunner seam — no fan-out, no timing. A non-default value (7)
  // so a hard-coded default could never satisfy the assertion.
  const model = emptyManifestModel();
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const mcp = {
    toolsForRole: () => ({}),
    toolSurfaceForRole: () => ({ direct: {}, deferred: {} }),
  };
  let captured: number | undefined;
  const workerRunner = async (
    _agent: unknown,
    workerInput: { subagentLimit?: number },
  ): Promise<WorkerResult> => {
    captured = workerInput.subagentLimit;
    return { kind: 'blocked', reason: 'captured' };
  };
  const input = {
    cwd: '/tmp/adapter-editorcap',
    resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null, subagentLimit: 7 },
    credentials,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    github: {},
    goal: 'g',
    criteria: undefined,
    branch: undefined,
    state: {},
  };
  const orch = defaultMakeOrchestrator({
    input,
    mcp,
    rollingContext: '',
    state: {},
    stepCounter: () => undefined,
    workerRunner,
  } as never);
  const res = await orch.runWorker({
    group: group('core'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  assert.equal(res.kind, 'blocked');
  assert.equal(
    captured,
    7,
    'the run-loop adapter threads resolved.subagentLimit into the worker input',
  );
});

test('defaultMakeOrchestrator.runWorker: resuming a recordingFailed transcript still resumes, but warns (issue #220)', async () => {
  // resumeMessagesFor (run-loop-adapter.ts) is looked up before the transcript for this run begins,
  // so seed an interrupted 'working' transcript for group 'core' carrying the same on-disk marker
  // TranscriptStore.findResumable checks (transcript-store.test.ts proves how the marker gets there
  // — a recorder that hit 3 consecutive append failures); here we assert the adapter's reaction.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-transcript-'));
  const store = new TranscriptStore(dir);
  const rec = await store.begin({ group: 'core', stage: 'working' });
  await rec.step([{ role: 'assistant', content: 'partial answer before the recorder died' }]);
  await writeFile(join(dir, 'transcripts', 'core', 'working-1.jsonl.recording-failed'), '');

  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const warnings: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const model = emptyManifestModel();
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const mcp = {
    toolsForRole: () => ({}),
    toolSurfaceForRole: () => ({ direct: {}, deferred: {} }),
  };
  const input = {
    cwd: '/tmp/adapter-compaction',
    resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null },
    credentials,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    github: {},
    goal: 'g',
    criteria: undefined,
    branch: undefined,
    state: {},
  };

  try {
    const orch = defaultMakeOrchestrator({
      input,
      mcp,
      rollingContext: '',
      state: { transcripts: () => store },
      stepCounter: () => undefined,
    } as never);

    const res = await orch.runWorker({
      group: group('core'),
      checkout: { path: '/tmp/wt' },
      baseBranch: 'main',
    } as never);
    assert.equal(res.kind, 'blocked'); // empty manifest → blocked, but resume already happened first
    assert.ok(
      warnings.some((w) => /recorder had persistent write failures/.test(w)),
      'the recordingFailed transcript surfaced its resume warning',
    );
  } finally {
    process.stderr.write = realStderrWrite;
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultMakeOrchestrator.releaseGroup: drops the group carry-over so the next pass cold-starts', async () => {
  // The Coordinator conversation is carried task→task through workerHandles (issue #107). Once the
  // WorkLoop is done with the group nothing can reuse it, so releaseGroup must drop it — otherwise a
  // many-group run ends holding every group's full ModelMessage[].
  const model = emptyManifestModel();
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const priorHandles: Array<{ messages: ModelMessage[] } | undefined> = [];
  const workerRunner = async (
    agent: unknown,
    workerInput: { priorHandle?: { messages: ModelMessage[] } },
  ): Promise<WorkerResult> => {
    priorHandles.push(workerInput.priorHandle);
    return {
      kind: 'ok',
      delivery: delivery(),
      handle: { agent, messages: [{ role: 'assistant', content: 'carried' }] },
    } as never;
  };
  const orch = defaultMakeOrchestrator({
    input: {
      cwd: '/tmp/adapter-release-group',
      resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null },
      credentials,
      agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
      github: {},
      goal: 'g',
      criteria: undefined,
      branch: undefined,
      state: {},
    },
    mcp: { toolsForRole: () => ({}), toolSurfaceForRole: () => ({ direct: {}, deferred: {} }) },
    rollingContext: '',
    state: {},
    stepCounter: () => undefined,
    workerRunner,
  } as never);

  const invoke = () =>
    orch.runWorker({
      group: group('core'),
      checkout: { path: '/tmp/wt' },
      baseBranch: 'main',
    } as never);

  await invoke();
  await invoke();
  orch.releaseGroup?.('core');
  await invoke();

  assert.equal(priorHandles[0], undefined, 'first task of a group cold-starts');
  assert.deepEqual(
    priorHandles[1]?.messages,
    [{ role: 'assistant', content: 'carried' }],
    'the second task continues the first task’s conversation',
  );
  assert.equal(priorHandles[2], undefined, 'after releaseGroup the carry-over is gone');
});

// Note (issue #129): the adapter threads `{ stepMs: resolved.llmStepTimeoutMs }` into every agent
// `defaultMakeOrchestrator` builds (worker/reviewer/orchestrator/compactor + the CI-fix subagents).
// A behavioral end-to-end assertion here would have to drive `defaultMakeOrchestrator`, which always
// constructs a network-bound Compactor (ModelLimitsRegistry → OpenRouterClient), so a stalled-model
// test becomes network-timing dependent. The threading is instead proven where it is deterministic:
// each factory's own stall test (planner/worker/reviewer.test.ts) fires the deadline and surfaces the
// StepTimeoutError, ci-fix.test.ts covers FixSessionSubagents.timeout, and commands.test.ts proves the
// resolved value reaches RunLoopInput. The fan-out wiring itself is type-checked.

// ---- web tools + web_search gating (issue #112) ----

const OR = undefined; // OpenRouter endpoint (default when baseURL is unset)

test('webSearchProviderOptions: unset → CI-fix only; true → all Worker calls; false → never (issue #112)', () => {
  const hasWebSearch = (po: ReturnType<typeof webSearchProviderOptions>): boolean =>
    (po?.openrouter?.tools ?? []).some((t) => t.type === 'openrouter:web_search');
  // unset (undefined): CI-fix on, regular off.
  assert.equal(
    hasWebSearch(webSearchProviderOptions(undefined, true, OR)),
    true,
    'unset → CI-fix on',
  );
  assert.equal(webSearchProviderOptions(undefined, false, OR), undefined, 'unset → regular off');
  // true: on for both.
  assert.equal(hasWebSearch(webSearchProviderOptions(true, true, OR)), true);
  assert.equal(hasWebSearch(webSearchProviderOptions(true, false, OR)), true, 'true → regular on');
  // false: off for both, including CI-fix.
  assert.equal(webSearchProviderOptions(false, true, OR), undefined, 'false → CI-fix off');
  assert.equal(webSearchProviderOptions(false, false, OR), undefined, 'false → regular off');
});

test('webSearchProviderOptions: the OpenRouter web_search server tool is NEVER attached off OpenRouter', () => {
  // Root cause of the observed `tools[0].type:type is illegal` crash: the web_search server tool is
  // openrouter-namespaced, and z.ai/kimi reject it outright. Even with web_search fully enabled, a
  // non-OpenRouter endpoint must get no server tool — the DuckDuckGo function tool covers search there.
  const zai = 'https://api.z.ai/api/coding/paas/v4';
  assert.equal(
    webSearchProviderOptions(true, true, zai),
    undefined,
    'explicit true, still gated off',
  );
  assert.equal(
    webSearchProviderOptions(undefined, true, zai),
    undefined,
    'CI-fix default, gated off',
  );
  assert.equal(
    webSearchProviderOptions({ enabled: true }, false, zai),
    undefined,
    'object form gated',
  );
});

test('webSearchProviderOptions: object form gates via `enabled` and threads domain filters (issue #195)', () => {
  const params = (po: ReturnType<typeof webSearchProviderOptions>) => {
    const t = (po?.openrouter?.tools ?? [])[0];
    return t?.type === 'openrouter:web_search' ? t.parameters : undefined;
  };
  // `enabled` occupies the same tri-state axis as the bare boolean.
  assert.notEqual(
    params(webSearchProviderOptions({ enabled: true }, false, OR)),
    undefined,
    'enabled:true → regular on',
  );
  assert.equal(
    webSearchProviderOptions({ enabled: false }, true, OR),
    undefined,
    'enabled:false → CI-fix off',
  );
  assert.notEqual(
    params(webSearchProviderOptions({}, true, OR)),
    undefined,
    'enabled unset → CI-fix on',
  );
  assert.equal(webSearchProviderOptions({}, false, OR), undefined, 'enabled unset → regular off');
  // Domain filters reach the server-tool payload when enabled.
  const p = params(
    webSearchProviderOptions(
      { enabled: true, allowedDomains: ['docs.rs'], excludedDomains: ['spam.example'] },
      false,
      OR,
    ),
  );
  assert.deepEqual(p?.allowed_domains, ['docs.rs']);
  assert.deepEqual(p?.excluded_domains, ['spam.example']);
  // Domains on a disabled config never attach.
  assert.equal(
    webSearchProviderOptions({ enabled: false, allowedDomains: ['docs.rs'] }, true, OR),
    undefined,
  );
  // A bare boolean carries no domain parameters (back-compat).
  assert.deepEqual(params(webSearchProviderOptions(true, false, OR)), {});
});

test('makeBudgetCheck: no check without a ceiling or tracker; enforces token + cost ceilings (issue #190)', async () => {
  const noPricing: ModelLimitsLookup = {
    preload: async () => {},
    forModel: async (id) => {
      throw new ModelNotFound(id);
    },
  };
  const priced: ModelLimitsLookup = {
    preload: async () => {},
    forModel: async (id) => ({
      modelId: id,
      promptUsdPerToken: 0.001,
      completionUsdPerToken: 0.002,
    }),
  };
  const usage = (input: number, output: number): LanguageModelUsage => ({
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
  });
  const run = async (
    tracker: UsageTracker | undefined,
    cost: number | undefined,
    tokens: number | undefined,
  ) => {
    const check = makeBudgetCheck(tracker, cost, tokens);
    if (!check) throw new Error('expected a budget check');
    return check();
  };

  // No ceiling → no check; no tracker → no check.
  assert.equal(makeBudgetCheck(new UsageTracker(noPricing), undefined, undefined), undefined);
  assert.equal(makeBudgetCheck(undefined, 1, 1000), undefined);

  // Token ceiling: 600 + 500 = 1100 ≥ 1000 → exceeded (pricing irrelevant).
  const t1 = new UsageTracker(noPricing);
  t1.record('worker', 'm', usage(600, 500));
  const s1 = await run(t1, undefined, 1000);
  assert.equal(s1.exceeded, true);
  if (s1.exceeded) assert.match(s1.reason, /token ceiling/);
  // Under the token ceiling → not exceeded.
  assert.equal((await run(t1, undefined, 5000)).exceeded, false);

  // Cost ceiling: 600*0.001 + 500*0.002 = $1.60 ≥ $1.00 → exceeded.
  const t2 = new UsageTracker(priced);
  t2.record('worker', 'm', usage(600, 500));
  const s2 = await run(t2, 1.0, undefined);
  assert.equal(s2.exceeded, true);
  if (s2.exceeded) assert.match(s2.reason, /cost ceiling/);

  // Cost unknown (unpriced model) → the cost ceiling cannot fire.
  const t3 = new UsageTracker(noPricing);
  t3.record('worker', 'm', usage(600, 500));
  assert.equal((await run(t3, 0.0001, undefined)).exceeded, false);
});

test('selfReviewVerifyCommand: configured wins; TS repo falls back to typecheck; else undefined', async () => {
  // Configured command is used verbatim, no detection.
  assert.equal(selfReviewVerifyCommand('bun test', '/nope'), 'bun test');

  const dir = await mkdtemp(join(tmpdir(), 'aitm-selfreview-'));
  try {
    // No tsconfig, nothing configured → no shell verify (review-only pass).
    assert.equal(selfReviewVerifyCommand(null, dir), undefined);
    assert.equal(selfReviewVerifyCommand(undefined, dir), undefined);
    // A TS repo (tsconfig.json present) gets the conservative typecheck fallback.
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    assert.equal(selfReviewVerifyCommand(null, dir), 'tsc --noEmit');
    // Configured still wins even for a TS repo.
    assert.equal(selfReviewVerifyCommand('bun run typecheck', dir), 'bun run typecheck');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- persistRollingContext (issue #123) ------------------------------------

test('persistRollingContext accumulates across groups and persists the running total', async () => {
  const writes: string[] = [];
  const state = { writeContext: async (s: string) => void writes.push(s) };

  const after1 = await persistRollingContext(state, '', {
    group: group('g1'),
    pr: pr(1),
    delivery: delivery(),
  });
  assert.ok(after1.includes('PR #1 — g1'), 'first digest present');
  assert.equal(writes.length, 1, 'persisted once');
  assert.equal(writes[0], after1, 'persisted the accumulated value, not a bare block');

  const after2 = await persistRollingContext(state, after1, {
    group: group('g2'),
    pr: pr(2),
    delivery: delivery(),
  });
  assert.ok(after2.startsWith(after1), "second write extends the first, doesn't replace it");
  assert.ok(after2.includes('PR #2 — g2'), 'second digest appended');
  assert.equal(writes[1], after2, 'persisted the running total');
});

test('persistRollingContext is failure-tolerant: a writeContext rejection never propagates', async () => {
  const state = {
    writeContext: async () => {
      throw new Error('disk full');
    },
  };
  // Must resolve (not reject) so the caller's openPr still returns the already-open PR.
  const out = await persistRollingContext(state, '', {
    group: group('g1'),
    pr: pr(7),
    delivery: delivery(),
  });
  assert.ok(
    out.includes('PR #7 — g1'),
    'still returns the accumulated context despite the write failure',
  );
});

test('persistRollingContext tolerates a state port without writeContext (optional method omitted)', async () => {
  const out = await persistRollingContext({}, '', {
    group: group('g1'),
    pr: pr(3),
    delivery: delivery(),
  });
  assert.ok(out.includes('PR #3 — g1'), 'accumulates even when nothing persists it');
});

// ---- cause preservation (issue #101 slice 04, task 18) --------------------

test('describeError: an Error is returned as-is — same object, same message, cause untouched', () => {
  const original = new Error('boom', { cause: 'root cause' });
  const described = describeError(original);
  assert.equal(described, original);
  assert.equal(described.message, 'boom');
  assert.equal(described.cause, 'root cause');
});

test('describeError: a non-Error throw is wrapped, same message text, original value as cause', () => {
  const described = describeError('disk full');
  assert.equal(described.message, 'disk full');
  assert.equal(described.cause, 'disk full');
});

// ---- retryProgressMessage (issue #01b liveliness) --------------------------

test('retryProgressMessage: renders reason, seconds, and the attempt/max ratio — never an empty "Rate limited:" line', () => {
  const line = retryProgressMessage({
    attempt: 3,
    maxAttempts: 10,
    delayMs: 15_000,
    reason: 'HTTP 429',
  });
  assert.equal(line, 'Rate limited (HTTP 429), retrying in 15s (3/10)');
});

test('retryProgressMessage: rounds a sub-second delay to whole seconds, never negative', () => {
  assert.equal(
    retryProgressMessage({ attempt: 1, maxAttempts: 10, delayMs: 600, reason: 'overloaded' }),
    'Rate limited (overloaded), retrying in 1s (1/10)',
  );
  assert.equal(
    retryProgressMessage({ attempt: 1, maxAttempts: 10, delayMs: -50, reason: 'overloaded' }),
    'Rate limited (overloaded), retrying in 0s (1/10)',
  );
});

test('createRollingContextAccumulator serializes concurrent appends without losing a digest', async () => {
  const writes: string[] = [];
  // A staggered writeContext: the first append is made slow so a naive read-modify-write on a shared
  // snapshot would let the second append start from the same base and clobber the first.
  let calls = 0;
  const state = {
    writeContext: async (s: string) => {
      const delay = calls++ === 0 ? 20 : 0;
      await new Promise((r) => setTimeout(r, delay));
      writes.push(s);
    },
  };
  const acc = createRollingContextAccumulator(state, '');

  const [a, b, c] = await Promise.all([
    acc.append({ group: group('g1'), pr: pr(1), delivery: delivery() }),
    acc.append({ group: group('g2'), pr: pr(2), delivery: delivery() }),
    acc.append({ group: group('g3'), pr: pr(3), delivery: delivery() }),
  ]);

  // Every append reads the context left by the previous one, so each result is a strict prefix-extend
  // of the last and the final value carries all three digests.
  assert.ok(a.includes('PR #1 — g1'));
  assert.ok(b.startsWith(a) && b.includes('PR #2 — g2'), 'second extends the first');
  assert.ok(c.startsWith(b) && c.includes('PR #3 — g3'), 'third extends the second');
  assert.equal(acc.current(), c, 'current() is the newest accumulated context');
  for (const marker of ['PR #1 — g1', 'PR #2 — g2', 'PR #3 — g3']) {
    assert.ok(acc.current().includes(marker), `no lost digest: ${marker}`);
  }
});

test('createRollingContextAccumulator keeps queuing after a write failure (chain never wedges)', async () => {
  let calls = 0;
  const state = {
    writeContext: async () => {
      if (calls++ === 0) throw new Error('disk full');
    },
  };
  const acc = createRollingContextAccumulator(state, '');
  const a = await acc.append({ group: group('g1'), pr: pr(1), delivery: delivery() });
  const b = await acc.append({ group: group('g2'), pr: pr(2), delivery: delivery() });
  assert.ok(
    a.includes('PR #1 — g1'),
    'first append still returns its context despite write failure',
  );
  assert.ok(b.startsWith(a) && b.includes('PR #2 — g2'), 'a later append still proceeds');
  assert.equal(acc.current(), b);
});

// ---- MCP reap on abort (signal cancellation cleanup, slice 02) --------------

// A pre-connected McpClientManager whose single fake client counts its close() calls, so a test can
// assert the adapter reaps it. `close` is what kills the stdio child in production.
function countingMcp(): { mcp: McpClientManager; closes: () => number } {
  let clientClosed = 0;
  const mcp = new McpClientManager({
    servers: { local: { command: 'local-mcp' } },
    createClient: (async () =>
      ({
        tools: async () => ({}),
        close: async () => {
          clientClosed += 1;
        },
      }) as never) as never,
  });
  return { mcp, closes: () => clientClosed };
}

test('runLoopAdapter: aborting the run closes MCP to reap stdio children and surfaces cancelled', async () => {
  const controller = new AbortController();
  const { mcp, closes } = countingMcp();
  await mcp.connectAll();
  const { state } = makeState();

  const result = await runLoopAdapter(
    { ...makeInput(), signal: controller.signal },
    seams({
      state,
      makeMcp: () => mcp,
      // Abort mid-run — before the `finally` — so only the eager abort listener can close MCP.
      planGroups: async () => {
        controller.abort();
        return { kind: 'ok', groups: [group('only')] };
      },
    }),
  );

  // The WorkLoop threads this signal too (run-loop-adapter.ts new WorkLoop({..., signal})), so
  // once aborted it reports cancelled (exit 2) instead of quietly finishing the group to success.
  assert.equal(result.kind, 'cancelled', 'an aborted run must surface cancelled, not success');
  assert.equal(closes(), 1, 'MCP client closed once when the run aborts');
});

test('runLoopAdapter: a completed run closes MCP once and detaches the reap listener', async () => {
  const controller = new AbortController();
  const { mcp, closes } = countingMcp();
  await mcp.connectAll();
  const { state } = makeState();

  const result = await runLoopAdapter(
    { ...makeInput(), signal: controller.signal },
    seams({ state, makeMcp: () => mcp }),
  );

  assert.equal(result.kind, 'success');
  assert.equal(closes(), 1, 'the run releases the MCP manager it drove, exactly once');
  // Aborting AFTER the run must reap nothing: the disposer released the listener, so a signal the
  // caller keeps alive (the CLI's run-wide controller) can no longer re-enter the adapter's teardown.
  controller.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closes(), 1, 'listener detached at run end → a later abort reaps nothing');
});

test('defaultPlanGroups: a throw during the planner call still ends its transcript', async () => {
  // The planner stage is recorded but never resumed, so an unfinished record is dead weight nothing
  // ever closes. The `end()` therefore rides the same finally as the heartbeat stop. Injected through
  // the one input the planner call reads and nothing before it does — `maxPrs`, since the scout
  // survey now runs first and reads `criteria` — because runPlanner itself is total; the guarantee
  // under test is structural, not a specific failure mode.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-planner-transcript-'));
  try {
    const input: RunLoopInput = { ...makeInput(), cwd: dir, state: new StateStore(dir) };
    Object.defineProperty(input.resolved, 'maxPrs', {
      get: () => {
        throw new Error('planner input exploded');
      },
    });

    await assert.rejects(
      // No planGroups seam → the real defaultPlanGroups runs; the MCP seam keeps it off any transport.
      runLoopAdapter(
        input,
        seams({ planGroups: undefined, makeMcp: () => new McpClientManager({ servers: {} }) }),
      ),
      /planner input exploded/,
    );

    const transcript = await readFile(
      join(dir, 'transcripts', 'planner', 'planner-1.jsonl'),
      'utf8',
    );
    const records = transcript
      .split('\n')
      .filter((line) => line !== '')
      .map((line): { kind?: string; outcome?: string } => JSON.parse(line));
    assert.deepEqual(
      records.filter((r) => r.kind === 'run-end').map((r) => r.outcome),
      ['error'],
      'the planner transcript is closed exactly once, as an error',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runLoopAdapter: a run that throws still releases MCP and the background processes', async () => {
  // Teardown hangs off the run's disposer, not off a flag set on the happy path: whatever the run
  // dies of — here a planner throw, in production an MCP transport that rejects connectAll with
  // earlier servers already connected — the stdio children and background processes still get reaped.
  const { mcp, closes } = countingMcp();
  await mcp.connectAll();
  const bg = backgroundProcessTools({ cwd: process.cwd() });
  const leftover = bg.manager.start('sleep 30');
  assert.equal(leftover.running, true, 'leftover process started');

  try {
    await assert.rejects(
      runLoopAdapter(
        makeInput(),
        seams({
          makeMcp: () => mcp,
          makeBackground: () => bg,
          planGroups: async () => {
            throw new Error('planner exploded');
          },
        }),
      ),
      /planner exploded/,
    );
    assert.equal(closes(), 1, 'MCP closed on the failure path');
    await until(() => bg.manager.list().every((p) => !p.running));
  } finally {
    bg.manager.killAll('SIGKILL');
  }
});

// ---- recordStepDeltas: per-step transcript deltas from cumulative SDK events (issue #175) ----

test('recordStepDeltas: records only the per-step delta from cumulative onStepFinish events (issue #175)', () => {
  const recorded: Array<{ count: number; usage: unknown }> = [];
  const recorder: TranscriptRecorder = {
    step: async (messages, usage) => {
      recorded.push({ count: messages.length, usage });
    },
    compaction: async () => {},
    end: async () => {},
  };
  const onStep = recordStepDeltas(recorder);
  const m = (i: number) => ({ role: 'assistant' as const, content: `m${i}` });
  // ai@6 hands the callback the CUMULATIVE response list each step: [m0,m1], [m0..m3], [m0..m5].
  onStep({ response: { messages: [m(0), m(1)] }, usage: { totalTokens: 7 } });
  onStep({ response: { messages: [m(0), m(1), m(2), m(3)] } });
  onStep({ response: { messages: [m(0), m(1), m(2), m(3), m(4), m(5)] } });
  assert.deepEqual(
    recorded.map((r) => r.count),
    [2, 2, 2],
    'per-step deltas, not the cumulative [2, 4, 6]',
  );
  assert.equal(
    (recorded[0]?.usage as { totalTokens?: number } | undefined)?.totalTokens,
    7,
    'usage forwarded with the first delta',
  );
});

test('recordStepDeltas: a step with no new messages records nothing (issue #175)', () => {
  let calls = 0;
  const recorder: TranscriptRecorder = {
    step: async () => {
      calls += 1;
    },
    compaction: async () => {},
    end: async () => {},
  };
  const onStep = recordStepDeltas(recorder);
  const m = (i: number) => ({ role: 'assistant' as const, content: `m${i}` });
  onStep({ response: { messages: [m(0)] } });
  onStep({ response: { messages: [m(0)] } }); // unchanged cumulative → empty delta → no write
  assert.equal(calls, 1);
});

// ---- per-group Coordinator carry-over ---------------------------------------

// Drive N runWorker calls through defaultMakeOrchestrator with a capturing workerRunner, so the
// carry-over is asserted at the seam the production path actually uses.
function carryOverHarness(results: Array<'ok' | 'blocked'>): {
  orch: ReturnType<typeof defaultMakeOrchestrator>;
  seen: Array<readonly unknown[] | undefined>;
} {
  const model = emptyManifestModel();
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const seen: Array<readonly unknown[] | undefined> = [];
  let call = 0;
  const workerRunner = async (
    _agent: unknown,
    workerInput: { priorHandle?: { messages: readonly unknown[] } },
  ): Promise<WorkerResult> => {
    seen.push(workerInput.priorHandle?.messages);
    const kind = results[call++] ?? 'ok';
    if (kind === 'blocked') return { kind: 'blocked', reason: 'nope' };
    return {
      kind: 'ok',
      delivery: { branch: 'b', draftCommitMessage: 'm', changes: [], progressEntries: [] },
      // A distinct message array per call, so the assertions can tell which pass was carried.
      handle: { agent: {}, messages: [{ role: 'assistant', content: `pass-${call}` }] },
    } as unknown as WorkerResult;
  };
  const orch = defaultMakeOrchestrator({
    input: {
      cwd: '/tmp/adapter-carryover',
      resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null },
      credentials,
      agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
      github: {},
      goal: 'g',
      criteria: undefined,
      branch: undefined,
      state: {},
    },
    mcp: { toolsForRole: () => ({}), toolSurfaceForRole: () => ({ direct: {}, deferred: {} }) },
    rollingContext: '',
    state: {},
    stepCounter: () => undefined,
    workerRunner,
  } as never);
  return { orch, seen };
}

test("runWorker: a group's second task continues the first task's conversation", async () => {
  // Half the wall-clock of a real run went to re-orientation: every task cold-started a Coordinator
  // that re-read the same files. The second task must inherit the first's messages.
  const { orch, seen } = carryOverHarness(['ok', 'ok']);
  const call = { group: group('core'), checkout: { path: '/tmp/wt' }, baseBranch: 'main' };
  await orch.runWorker(call as never);
  await orch.runWorker(call as never);
  assert.equal(seen[0], undefined, 'the first task of a group starts cold');
  assert.deepEqual(seen[1], [{ role: 'assistant', content: 'pass-1' }]);
});

test('runWorker: a blocked task leaves the carry-over intact for the next one', async () => {
  // A blocked pass has no handle. Dropping the group back to a cold start would make failure
  // doubly expensive — the retry would re-survey everything the successful pass already read.
  const { orch, seen } = carryOverHarness(['ok', 'blocked', 'ok']);
  const call = { group: group('core'), checkout: { path: '/tmp/wt' }, baseBranch: 'main' };
  await orch.runWorker(call as never);
  await orch.runWorker(call as never);
  await orch.runWorker(call as never);
  assert.deepEqual(seen[1], [{ role: 'assistant', content: 'pass-1' }]);
  assert.deepEqual(seen[2], [{ role: 'assistant', content: 'pass-1' }], 'still the last ok pass');
});

test('runWorker: carry-over never crosses group boundaries', async () => {
  const { orch, seen } = carryOverHarness(['ok', 'ok']);
  await orch.runWorker({
    group: group('core'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  await orch.runWorker({
    group: group('api'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  assert.equal(seen[1], undefined, 'a different group starts cold');
});

// ---- run cancellation reaches the Worker ------------------------------------

// Capture WorkerInput.signal at the same seam production uses. The Coordinator's generation is
// cancelled by SubagentInit.signal; the editor fanout is cancelled ONLY by WorkerInput.signal, so
// the adapter has to forward it or an abort leaves every editor leaf running to completion.
function workerSignalHarness(runSignal?: AbortSignal): {
  orch: ReturnType<typeof defaultMakeOrchestrator>;
  seen: Array<AbortSignal | undefined>;
} {
  const model = emptyManifestModel();
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const seen: Array<AbortSignal | undefined> = [];
  const workerRunner = async (
    _agent: unknown,
    workerInput: { signal?: AbortSignal },
  ): Promise<WorkerResult> => {
    seen.push(workerInput.signal);
    return { kind: 'blocked', reason: 'captured' };
  };
  const orch = defaultMakeOrchestrator({
    input: {
      cwd: '/tmp/adapter-signal',
      resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null },
      credentials,
      agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
      github: {},
      goal: 'g',
      criteria: undefined,
      branch: undefined,
      state: {},
      ...(runSignal ? { signal: runSignal } : {}),
    },
    mcp: { toolsForRole: () => ({}), toolSurfaceForRole: () => ({ direct: {}, deferred: {} }) },
    rollingContext: '',
    state: {},
    stepCounter: () => undefined,
    workerRunner,
  } as never);
  return { orch, seen };
}

test("runWorker: the invocation's signal reaches WorkerInput (the editor fanout's abort)", async () => {
  const controller = new AbortController();
  const { orch, seen } = workerSignalHarness();
  await orch.runWorker({
    group: group('core'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
    signal: controller.signal,
  } as never);
  assert.equal(seen[0], controller.signal);
});

test("runWorker: no invocation signal → falls back to the run's own signal", async () => {
  // Callers of this port that predate WorkerInvocation.signal must still cancel: the adapter's own
  // input.signal is the same run-scoped handle the WorkLoop would have passed.
  const controller = new AbortController();
  const { orch, seen } = workerSignalHarness(controller.signal);
  await orch.runWorker({
    group: group('core'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  assert.equal(seen[0], controller.signal);
});

test('runWorker: no signal anywhere → WorkerInput omits it', async () => {
  const { orch, seen } = workerSignalHarness();
  await orch.runWorker({
    group: group('core'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  assert.equal(seen[0], undefined);
});

// ---- specialist-discovery failure degrades, never poisons later workers -----

// A throwing discoverSpecialists must not reject the memoized roster promise. The rejection would be
// memoized and re-awaited by every later runWorker (breaking each group before it reaches the Worker)
// and would surface as an unhandled rejection from the fire-and-forget announce (fatal on Node ≥15).
// Both must instead degrade to an empty roster. `seen` records the agent each Worker call receives, so
// the tests can prove execution still reaches the Worker.
function discoveryFailureHarness(): {
  orch: ReturnType<typeof defaultMakeOrchestrator>;
  seen: unknown[];
} {
  const model = emptyManifestModel();
  const credentials = {
    modelFor: () => model,
    modelForCapability: () => model,
    modelIdFor: () => 'openai/gpt-5',
    modelIdForCapability: () => 'openai/gpt-5',
  };
  const seen: unknown[] = [];
  const workerRunner = async (agent: unknown): Promise<WorkerResult> => {
    seen.push(agent);
    return { kind: 'blocked', reason: 'captured' };
  };
  const orch = defaultMakeOrchestrator({
    input: {
      cwd: '/tmp/adapter-discovery-fail',
      resolved: { openrouterApiKey: 'sk-or-test', maxSessions: null },
      credentials,
      agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
      github: {},
      goal: 'g',
      criteria: undefined,
      branch: undefined,
      state: {},
    },
    mcp: { toolsForRole: () => ({}), toolSurfaceForRole: () => ({ direct: {}, deferred: {} }) },
    rollingContext: '',
    state: {},
    stepCounter: () => undefined,
    workerRunner,
    discoverSpecialists: async () => {
      throw new Error('boom: cannot read .claude/agents');
    },
  } as never);
  return { orch, seen };
}

test('runWorker: a discoverSpecialists failure degrades to an empty roster, not a poisoned promise', async () => {
  const { orch, seen } = discoveryFailureHarness();
  // Each call awaits the memoized roster before routing. A rejected roster would throw here — and for
  // every later group — never reaching the Worker.
  await orch.runWorker({
    group: group('core'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  await orch.runWorker({
    group: group('api'),
    checkout: { path: '/tmp/wt' },
    baseBranch: 'main',
  } as never);
  assert.equal(seen.length, 2, 'both groups reached the Worker despite the discovery failure');
});

test('defaultMakeOrchestrator: a discoverSpecialists failure never leaks an unhandled rejection', async () => {
  const captured: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    captured.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    // Construction fires the fire-and-forget announce (`specialistRoster().then(...)`); the runWorker
    // exercises the awaited consumer. Neither may surface the discovery failure as a rejection.
    const { orch } = discoveryFailureHarness();
    await orch
      .runWorker({
        group: group('core'),
        checkout: { path: '/tmp/wt' },
        baseBranch: 'main',
      } as never)
      .catch(() => {});
    // Let any floating rejection settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  const leaked = captured.filter((r) => r instanceof Error && r.message.includes('boom'));
  assert.deepEqual(leaked, [], 'discovery failure degraded silently, no unhandled rejection');
});

// ---- Wave re-planning ------------------------------------------------------

test('a run plans another wave when the goal assessor says work remains', async () => {
  const goalsSeen: string[] = [];
  let assessments = 0;
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      planGroups: async (input): Promise<PlanGroupsOutcome> => {
        goalsSeen.push(input.goal);
        return { kind: 'ok', groups: [group(`g${goalsSeen.length}`)] };
      },
      assessGoal: async () => {
        assessments += 1;
        return assessments === 1
          ? { complete: false, remaining: 'build the web client', rationale: 'no ui yet' }
          : { complete: true, remaining: '', rationale: 'done' };
      },
    }),
  );
  assert.equal(result.kind, 'success');
  assert.equal(goalsSeen.length, 2, 'a second wave was planned');
  assert.equal(goalsSeen[1], 'build the web client', 'wave 2 plans the REMAINING goal');
  assert.equal(assessments, 2, 'each landed wave is assessed');
  assert.equal(result.outcomes.length, 2, 'outcomes accumulate across waves');
});

test('a complete verdict after the first wave ends the run', async () => {
  let plans = 0;
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      planGroups: async (): Promise<PlanGroupsOutcome> => {
        plans += 1;
        return { kind: 'ok', groups: [group('only')] };
      },
      assessGoal: async () => ({ complete: true, remaining: '', rationale: 'shipped' }),
    }),
  );
  assert.equal(result.kind, 'success');
  assert.equal(plans, 1, 'no extra wave when the goal is met');
});

test('a blocked wave is never assessed and never extended', async () => {
  let assessed = false;
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      planGroups: async () => ({ kind: 'blocked', reason: 'cannot parse goal' }),
      assessGoal: async () => {
        assessed = true;
        return { complete: false, remaining: 'more', rationale: '' };
      },
    }),
  );
  assert.equal(result.kind, 'blocked');
  assert.equal(assessed, false, 'a run that needs attention is not piled onto with more work');
});

test('a later wave that cannot be planned ends the run on what already shipped', async () => {
  let plans = 0;
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      planGroups: async (): Promise<PlanGroupsOutcome> => {
        plans += 1;
        return plans === 1
          ? { kind: 'ok', groups: [group('g1')] }
          : { kind: 'error', error: 'planner exploded' };
      },
      assessGoal: async () => ({ complete: false, remaining: 'more work', rationale: '' }),
    }),
  );
  // Wave 1 merged a real PR. Reporting `blocked` would bury that under a follow-up planning failure.
  assert.equal(result.kind, 'success');
  assert.equal(result.outcomes.length, 1);
});

test('wave groups are appended to the landed ones, with ids namespaced apart', async () => {
  const persisted: string[][] = [];
  const { state } = makeState();
  let assessments = 0;
  await runLoopAdapter(
    makeInput(),
    seams({
      state: {
        ...state,
        update: async (mutator) => {
          const next = await state.update(mutator);
          persisted.push(next.prGroups.map((g) => g.id));
          return next;
        },
      },
      // Both waves emit `g1`, exactly as a real Planner would — the collision is the point.
      planGroups: async (): Promise<PlanGroupsOutcome> => ({ kind: 'ok', groups: [group('g1')] }),
      assessGoal: async () => {
        assessments += 1;
        return assessments === 1
          ? { complete: false, remaining: 'more', rationale: '' }
          : { complete: true, remaining: '', rationale: '' };
      },
    }),
  );
  const last = persisted.at(-1) ?? [];
  assert.ok(last.includes('g1'), 'the landed group is still there');
  assert.ok(last.includes('w2-g1'), 'the second wave was namespaced, not collided');
});

test('an assessor that keeps naming the same remaining work does not loop forever', async () => {
  // Livelock guard: the wave ran, the assessor asked for the identical thing again. Another wave
  // would repeat work that just failed to satisfy it and bill the operator for it.
  let plans = 0;
  const result = await runLoopAdapter(
    makeInput(),
    seams({
      planGroups: async (): Promise<PlanGroupsOutcome> => {
        plans += 1;
        return { kind: 'ok', groups: [group(`g${plans}`)] };
      },
      assessGoal: async () => ({ complete: false, remaining: 'the same thing', rationale: '' }),
    }),
  );
  assert.equal(result.kind, 'success');
  assert.equal(plans, 2, 'one follow-up wave, then the repeat is refused');
});

test('the original goal is never re-planned as remaining work', async () => {
  let plans = 0;
  await runLoopAdapter(
    makeInput(),
    seams({
      planGroups: async (): Promise<PlanGroupsOutcome> => {
        plans += 1;
        return { kind: 'ok', groups: [group(`g${plans}`)] };
      },
      // Echoing the original goal back is the degenerate case — it would replan wave 1 verbatim.
      assessGoal: async (input) => ({ complete: false, remaining: input.goal, rationale: '' }),
    }),
  );
  assert.equal(plans, 1, 'the run stops instead of replanning the goal it just planned');
});

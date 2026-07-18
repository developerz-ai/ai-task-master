// Unit coverage for the production WorkLoop wiring. Every external dependency (Planner,
// Orchestrator, InPlaceCheckout, GitHubClient, MCP, StateStore) is driven through the adapter's
// seams so all four WorkLoopResult branches — success, awaiting-pr, blocked, session-cap —
// are reachable without spawning subagents, git, or `gh`. The integration suite covers the
// real stack end-to-end.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AUTONOMY_CONTRACT_TEXT,
  COMMUNICATION_CONTRACT_TEXT,
  SUBMIT_TOOL_NAME,
  SYSTEM_REMINDER_CONTRACT,
} from '@developerz.ai/ai-claude-compat';
import type { ToolSet } from 'ai';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { RunLoopInput } from '../cli/commands.ts';
import { Credentials } from '../credentials/credentials.ts';
import { GitHubClient } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { TOOL_SEARCH_TOOL_NAME } from '../mcp/tool-search.ts';
import type { Plan } from '../plan/schema.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import type { TranscriptRecorder } from '../state/transcript-store.ts';
import type { WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import {
  type AdapterStatePort,
  activeToolNames,
  applyHooks,
  branchFor,
  createRollingContextAccumulator,
  defaultMakeOrchestrator,
  describeError,
  exploreReadTools,
  githubThreadTool,
  harnessContextBlock,
  localEditTools,
  localReadTools,
  mcpTool,
  mountDeferredTools,
  type PlanGroupsOutcome,
  persistRollingContext,
  planToPrGroups,
  type RunLoopAdapterSeams,
  recordStepDeltas,
  reminderAgentSystemPrompt,
  resolvePlannerTools,
  resolveWorkerTools,
  runLoopAdapter,
  runStepContextLine,
  sanitizeBranchComponent,
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
    makeOrchestrator: () => makeOrchestrator(),
    makeCheckout: () => makeCheckout(),
    makeGithub: () => makeGithub(),
    state,
    ...over,
  };
}

// ---- planToPrGroups (pure) -------------------------------------------------

test('planToPrGroups maps plan groups to pending PrGroups with aitm/<id> branches', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        tasks: [
          { description: 'a', complexity: 'complex' },
          { description: 'b', complexity: 'normal' },
        ],
        dependsOn: [],
      },
      {
        id: 'api',
        title: 'API',
        tasks: [{ description: 'c', complexity: 'simple' }],
        dependsOn: ['core'],
      },
    ],
  };
  const groups = planToPrGroups(plan);
  assert.deepEqual(
    groups.map((g) => ({
      id: g.id,
      branch: g.branch,
      status: g.status,
      tasks: g.tasks,
      dependsOn: g.dependsOn,
    })),
    [
      {
        id: 'core',
        branch: 'aitm/core',
        status: 'pending',
        tasks: [
          { id: 'core-1', text: 'a', complexity: 'complex', done: false },
          { id: 'core-2', text: 'b', complexity: 'normal', done: false },
        ],
        dependsOn: [],
      },
      {
        id: 'api',
        branch: 'aitm/api',
        status: 'pending',
        tasks: [{ id: 'api-1', text: 'c', complexity: 'simple', done: false }],
        dependsOn: ['core'],
      },
    ],
  );
});

// ---- branchFor / caller-specified branch -----------------------------------

test('branchFor: no requested branch defaults to aitm/<id>', () => {
  assert.equal(branchFor('core', undefined, 1), 'aitm/core');
  assert.equal(branchFor('core', undefined, 3), 'aitm/core');
});

test('branchFor: single group uses the requested branch verbatim', () => {
  assert.equal(branchFor('core', 'feature/login', 1), 'feature/login');
});

test('branchFor: multiple groups prefix the requested branch per group', () => {
  assert.equal(branchFor('core', 'feature/login', 2), 'feature/login/core');
  assert.equal(branchFor('api', 'feature/login', 2), 'feature/login/api');
});

test('sanitizeBranchComponent: maps unsafe Planner ids to valid ref components', () => {
  assert.equal(sanitizeBranchComponent('core'), 'core');
  assert.equal(sanitizeBranchComponent('.hidden'), 'hidden');
  assert.equal(sanitizeBranchComponent('foo.lock'), 'foo');
  assert.equal(sanitizeBranchComponent('a b:c'), 'a-b-c');
  assert.equal(sanitizeBranchComponent('trailing.'), 'trailing');
  assert.equal(sanitizeBranchComponent('...'), 'group');
});

test('branchFor: sanitizes an unsafe group id in default and prefixed forms', () => {
  // A Planner id that would otherwise produce an invalid ref (leading dot).
  assert.equal(branchFor('.weird', undefined, 1), 'aitm/weird');
  assert.equal(branchFor('.weird', 'feature/x', 2), 'feature/x/weird');
});

test('planToPrGroups: composes a valid ref even when the Planner id is unsafe', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        tasks: [{ description: 'a', complexity: 'normal' }],
        dependsOn: [],
      },
      {
        id: 'api.lock',
        title: 'API',
        tasks: [{ description: 'b', complexity: 'simple' }],
        dependsOn: [],
      },
    ],
  };
  const groups = planToPrGroups(plan, 'release/v2');
  assert.deepEqual(
    groups.map((g) => g.branch),
    ['release/v2/core', 'release/v2/api'],
  );
});

test('planToPrGroups: requested branch applied verbatim for a single-group plan', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        tasks: [{ description: 'a', complexity: 'normal' }],
        dependsOn: [],
      },
    ],
  };
  const groups = planToPrGroups(plan, 'release/v2');
  assert.equal(groups[0]?.branch, 'release/v2');
});

test('planToPrGroups: requested branch prefixes each group in a multi-group plan', () => {
  const plan: Plan = {
    goal: 'g',
    groups: [
      {
        id: 'core',
        title: 'Core',
        tasks: [{ description: 'a', complexity: 'normal' }],
        dependsOn: [],
      },
      {
        id: 'api',
        title: 'API',
        tasks: [{ description: 'b', complexity: 'simple' }],
        dependsOn: ['core'],
      },
    ],
  };
  const groups = planToPrGroups(plan, 'release/v2');
  assert.deepEqual(
    groups.map((g) => g.branch),
    ['release/v2/core', 'release/v2/api'],
  );
});

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

// ---- Default orchestrator bridge: no MCP → local fs-tools fallback ----------

test('mcpTool: partial-fill matches a namespaced MCP tool by canonical name, first in config order (issue #115)', () => {
  const a = { description: 'a' } as never;
  const b = { description: 'b' } as never;
  // Namespaced ToolSet as toolsForRole now produces it; insertion order = server/config order.
  const set = { mcp__fs__readFile: a, mcp__other__readFile: b, mcp__git__status: {} as never };
  assert.strictEqual(mcpTool(set, 'readFile'), a, 'first server in config order wins');
  assert.strictEqual(mcpTool(set, 'status'), set.mcp__git__status);
  // A canonical name no server exports → undefined (caller falls back to the local tool).
  assert.equal(mcpTool(set, 'writeFile'), undefined);
  // A bare (non-namespaced) key is never matched.
  assert.equal(mcpTool({ readFile: a }, 'readFile'), undefined);
  // Empty set (no MCP servers) → undefined → all-local fallback (bare `aitm start`).
  assert.equal(mcpTool({}, 'readFile'), undefined);
});

test('localEditTools supplies checkout-scoped readFile/writeFile/bash (no-MCP fallback)', () => {
  // When no MCP server provides edit tools, the Worker/Reviewer fall back to these so a bare
  // `aitm start` can still edit, commit and open a PR (instead of blocking).
  const tools = localEditTools('/tmp/some-checkout');
  assert.equal(typeof tools.readFile.execute, 'function');
  assert.equal(typeof tools.writeFile.execute, 'function');
  assert.equal(typeof tools.bash.execute, 'function');
});

test('localEditTools: threads bash deny/allow rules into the bash + multiBash tools (issue #113)', async () => {
  const tools = localEditTools('/tmp/wt', [{ pattern: 'git push --force*', action: 'deny' }]);
  const opts = { toolCallId: 't', messages: [] as never[] };
  const bashOut = (await tools.bash.execute?.({ command: 'git push --force' }, opts)) as {
    exitCode: number;
    denied?: boolean;
  };
  assert.equal(bashOut.exitCode, 126);
  assert.equal(bashOut.denied, true);
  const multiOut = (await tools.multiBash.execute?.({ commands: ['git push --force'] }, opts)) as {
    failedAt: number | null;
    exitCode: number;
  };
  assert.equal(multiOut.failedAt, 0);
  assert.equal(multiOut.exitCode, 126);
});

// Flatten a tool-result rendering to text for reminder assertions.
function renderedText(rendered: unknown): string {
  const r = rendered as { type: string; value: unknown };
  if (r.type === 'text') return r.value as string;
  if (r.type === 'content') {
    return (r.value as Array<{ type: string; text?: string }>)
      .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
      .join('\n');
  }
  return JSON.stringify(r.value);
}

test('localEditTools: a file changed on disk after its Read surfaces one file-changed reminder on the next file-tool result (issue #106)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-reminder-'));
  try {
    await writeFile(join(dir, 'a.ts'), 'v1', 'utf8');
    const tools = localEditTools(dir);
    const opts = { toolCallId: 't', messages: [] as never[] };
    // Model reads A (the tracker records its content hash).
    await tools.readFile.execute?.({ path: 'a.ts' }, opts);
    // A is modified on disk out from under the model.
    await writeFile(join(dir, 'a.ts'), 'v2-changed-on-disk', 'utf8');
    // An edit against the since-changed file is rejected (read-before-edit staleness, #104) — the
    // rejection is what flags A stale in the tracker.
    await assert.rejects(
      tools.editFile.execute?.(
        { path: 'a.ts', oldString: 'v2-changed-on-disk', newString: 'x' },
        opts,
      ) as Promise<unknown>,
      /modified since you read it/,
    );
    // The next successful file-tool result now carries exactly one file-changed-externally envelope.
    const rendered = await tools.readFile.toModelOutput?.({
      toolCallId: 't2',
      input: { path: 'b.ts' },
      output: '1\tcontents of b',
    });
    const text = renderedText(rendered);
    assert.equal((text.match(/<system-reminder>/g) ?? []).length, 1, 'exactly one envelope');
    assert.match(text, /a\.ts was modified on disk since you last read it/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('harnessContextBlock: one envelope carrying the claudeMd and currentDate sections (issue #106)', () => {
  const block = harnessContextBlock('# House style\n- single quotes only');
  assert.equal((block.match(/<system-reminder>/g) ?? []).length, 1, 'single envelope');
  assert.match(block, /# claudeMd\n# House style\n- single quotes only/);
  assert.match(block, /# currentDate\n\d{4}-\d{2}-\d{2}/);
  assert.match(block, /may or may not be relevant/);
  // No step supplied → no runProgress section (prompt-design.md §3).
  assert.equal(block.includes('# runProgress'), false, 'no progress section without a step');
});

test('harnessContextBlock: a step adds a runProgress section with the phase + N/M line (§3)', () => {
  const block = harnessContextBlock('# style', {
    phase: 'working',
    unit: 'group',
    index: 2,
    total: 5,
  });
  assert.equal((block.match(/<system-reminder>/g) ?? []).length, 1, 'still one envelope');
  assert.match(block, /# runProgress\nStep 2 of 5 — working/);
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
    maxSteps: 20,
    modelId: 'anthropic/claude-sonnet-4',
  });
  assert.match(prompt, /# style/, 'carries the style payload');
  assert.match(prompt, /You are the Planner\./, 'carries the role guidance');
  assert.ok(prompt.includes(SYSTEM_REMINDER_CONTRACT), 'carries the system-reminder contract');
  // #105: the always-on behavioral contracts are woven into every main-loop subagent prompt.
  assert.ok(prompt.includes(COMMUNICATION_CONTRACT_TEXT), 'carries the communication contract');
  assert.ok(prompt.includes(AUTONOMY_CONTRACT_TEXT), 'carries the autonomy contract');
  assert.match(prompt, /budget of 20 tool steps/, 'carries the role step-budget reminder');
  assert.match(prompt, /anthropic\/claude-sonnet-4/, 'self-identifies the routed model');
});

// ---- githubThreadTool ------------------------------------------------------

test('githubThreadTool dispatches reply and resolve to the GitHub client', async () => {
  const calls: string[] = [];
  const gh = {
    replyToThread: async (threadId: string, body: string) => {
      calls.push(`reply:${threadId}:${body}`);
    },
    resolveThread: async (threadId: string) => {
      calls.push(`resolve:${threadId}`);
    },
  };
  const t = githubThreadTool(gh);
  const exec = t.execute;
  assert.equal(typeof exec, 'function');
  if (typeof exec !== 'function') return;
  const ctx = { toolCallId: 'x', messages: [] };
  const r1 = await exec({ action: 'replyToThread', threadId: 't1', body: 'hi' }, ctx);
  const r2 = await exec({ action: 'resolveThread', threadId: 't2' }, ctx);
  assert.deepEqual(r1, { ok: true });
  assert.deepEqual(r2, { ok: true });
  assert.deepEqual(calls, ['reply:t1:hi', 'resolve:t2']);
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

// Note (issue #129): the adapter threads `{ stepMs: resolved.llmStepTimeoutMs }` into every agent
// `defaultMakeOrchestrator` builds (worker/reviewer/orchestrator/compactor + the CI-fix subagents).
// A behavioral end-to-end assertion here would have to drive `defaultMakeOrchestrator`, which always
// constructs a network-bound Compactor (ModelLimitsRegistry → OpenRouterClient), so a stalled-model
// test becomes network-timing dependent. The threading is instead proven where it is deterministic:
// each factory's own stall test (planner/worker/reviewer.test.ts) fires the deadline and surfaces the
// StepTimeoutError, ci-fix.test.ts covers FixSessionSubagents.timeout, and commands.test.ts proves the
// resolved value reaches RunLoopInput. The fan-out wiring itself is type-checked.

// ---- web tools + web_search gating (issue #112) ----

test('localEditTools mounts webFetch + datetime; fetchHtml only when its binary is available', () => {
  const tools = localEditTools('/tmp/x');
  assert.ok(tools.webFetch, 'webFetch present');
  assert.ok(tools.datetime, 'datetime present');
  assert.equal('fetchHtml' in tools, false, 'no fetchHtml when unavailable (default)');
  const withHtml = localEditTools('/tmp/x', undefined, true);
  assert.ok(withHtml.fetchHtml, 'fetchHtml mounted when available');
});

test('localReadTools (planner) mounts webFetch + datetime alongside the read-only set', () => {
  const tools = localReadTools('/tmp/x');
  assert.ok(tools.readFile && tools.grep && tools.glob, 'read-only core present');
  assert.ok(tools.webFetch && tools.datetime, 'web + time tools present');
  assert.equal('fetchHtml' in tools, false);
  assert.ok(localReadTools('/tmp/x', true).fetchHtml, 'fetchHtml mounted when available');
});

test('webSearchProviderOptions: unset → CI-fix only; true → all Worker calls; false → never (issue #112)', () => {
  const hasWebSearch = (po: ReturnType<typeof webSearchProviderOptions>): boolean =>
    (po?.openrouter?.tools ?? []).some((t) => t.type === 'openrouter:web_search');
  // unset (undefined): CI-fix on, regular off.
  assert.equal(hasWebSearch(webSearchProviderOptions(undefined, true)), true, 'unset → CI-fix on');
  assert.equal(webSearchProviderOptions(undefined, false), undefined, 'unset → regular off');
  // true: on for both.
  assert.equal(hasWebSearch(webSearchProviderOptions(true, true)), true);
  assert.equal(hasWebSearch(webSearchProviderOptions(true, false)), true, 'true → regular on');
  // false: off for both, including CI-fix.
  assert.equal(webSearchProviderOptions(false, true), undefined, 'false → CI-fix off');
  assert.equal(webSearchProviderOptions(false, false), undefined, 'false → regular off');
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

// ---- explore fan-out wiring (issue #126) -----------------------------------

const stubExplore = () =>
  tool({
    description: 'stub explore',
    inputSchema: z.object({ prompt: z.string() }),
    execute: async () => 'surveyed',
  });

test('exploreReadTools exposes exactly the checkout-confined read trio', () => {
  const tools = exploreReadTools('/tmp/some-checkout');
  assert.deepEqual(Object.keys(tools).sort(), ['glob', 'grep', 'readFile']);
  assert.equal(typeof tools.readFile?.execute, 'function');
});

test('exploreReadTools: the explore child readFile rejects a path escaping the worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-explore-'));
  try {
    const tools = exploreReadTools(dir);
    const exec = tools.readFile?.execute;
    assert.equal(typeof exec, 'function');
    await assert.rejects(
      () =>
        (exec as (i: unknown, o: unknown) => Promise<unknown>)(
          { path: '../escape' },
          { toolCallId: 't', messages: [] },
        ),
      /escapes worktree/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveWorkerTools mounts explore only when the caller wires it (never MCP-filled)', () => {
  // Bare no-MCP `aitm start`: empty server set, explore supplied → the manifest Worker gets the local
  // trio plus explore.
  const withExplore = resolveWorkerTools({}, '/tmp/wt', undefined, false, stubExplore());
  assert.equal('explore' in withExplore, true, 'explore present when wired');
  assert.equal(typeof withExplore.readFile.execute, 'function', 'local trio still filled');
  // Omitted (take-over flow / bare stubs) → absent, record behaves exactly as before.
  const withoutExplore = resolveWorkerTools({}, '/tmp/wt');
  assert.equal('explore' in withoutExplore, false, 'absent when not wired');
});

const stubMemory = () =>
  tool({
    description: 'stub memory',
    inputSchema: z.object({ action: z.string(), name: z.string() }),
    execute: async () => 'ok',
  });

test('applyHooks wraps the tool record when hooks are configured, no-op otherwise (issue #121)', () => {
  const base = resolveWorkerTools({}, '/tmp/wt');
  assert.equal(applyHooks(base, makeInput(), '/tmp/wt'), base, 'no hooks → same record reference');

  const input = makeInput();
  const hooked = {
    ...input,
    resolved: { ...input.resolved, hooks: { preToolUse: [{ command: './guard.sh' }] } },
  };
  const wrapped = applyHooks(base, hooked, '/tmp/wt');
  assert.notEqual(wrapped, base, 'hooks configured → a new wrapped record');
  assert.deepEqual(
    Object.keys(wrapped).sort(),
    Object.keys(base).sort(),
    'same tool names preserved',
  );
});

test('resolveWorkerTools mounts memory only when the caller wires it (never MCP-filled) — issue #118', () => {
  const withMemory = resolveWorkerTools({}, '/tmp/wt', undefined, false, undefined, stubMemory());
  assert.equal('memory' in withMemory, true, 'memory present when wired');
  const withoutMemory = resolveWorkerTools({}, '/tmp/wt');
  assert.equal('memory' in withoutMemory, false, 'absent when not wired');
});

test('resolvePlannerTools mounts explore only when the caller wires it', () => {
  const withExplore = resolvePlannerTools({}, '/tmp/repo', false, stubExplore());
  assert.equal('explore' in withExplore, true);
  const withoutExplore = resolvePlannerTools({}, '/tmp/repo');
  assert.equal('explore' in withoutExplore, false);
  // The Planner never gets a memory tool — it reads memory files directly (issue #118).
  assert.equal('memory' in withExplore, false, 'planner has no memory tool');
});

// ---- deferred MCP tool loading (issue #119) ----

function mcpFake(desc: string): ToolSet[string] {
  return { description: desc, inputSchema: { type: 'object' } } as ToolSet[string];
}

test('mountDeferredTools: below threshold (nothing deferred) mounts surplus direct, no tool_search (issue #119)', () => {
  const mount = mountDeferredTools({
    direct: { mcp__gh__create_issue: mcpFake('Create an issue.') },
    deferred: {},
  });
  assert.deepEqual(Object.keys(mount.extraTools), ['mcp__gh__create_issue']);
  assert.equal(mount.indexBlock, '');
  assert.equal(mount.activated, null);
  assert.equal(mount.deferredNames.size, 0);
  assert.equal(
    TOOL_SEARCH_TOOL_NAME in mount.extraTools,
    false,
    'no tool_search when nothing deferred',
  );
});

test('mountDeferredTools: above threshold defers surplus behind tool_search + a name-only index (issue #119)', () => {
  const mount = mountDeferredTools({
    direct: {},
    deferred: {
      mcp__gh__create_issue: mcpFake('Create an issue.'),
      mcp__db__query: mcpFake('Query the DB.'),
    },
  });
  assert.ok(TOOL_SEARCH_TOOL_NAME in mount.extraTools, 'tool_search mounted');
  assert.ok(
    'mcp__gh__create_issue' in mount.extraTools,
    'deferred tool guard-wrapped into the record',
  );
  assert.ok('mcp__db__query' in mount.extraTools);
  assert.match(mount.indexBlock, /mcp__gh__create_issue: Create an issue\./);
  assert.notEqual(mount.activated, null);
  assert.deepEqual([...mount.deferredNames].sort(), ['mcp__db__query', 'mcp__gh__create_issue']);
});

test('mountDeferredTools: fixed-slot-named MCP tools are not surplus — excluded from the mount (issue #119)', () => {
  const mount = mountDeferredTools({
    direct: {},
    deferred: { mcp__fs__readFile: mcpFake('read'), mcp__gh__x: mcpFake('x') },
  });
  // readFile is a fixed slot (partial-filled elsewhere) → not deferred here; only true surplus is.
  assert.deepEqual([...mount.deferredNames], ['mcp__gh__x']);
  assert.equal('mcp__fs__readFile' in mount.extraTools, false);
});

test('activeToolNames: hides un-activated deferred tools, always keeps submit + non-deferred (issue #119)', () => {
  const tools: ToolSet = {
    readFile: mcpFake('r'),
    mcp__gh__x: mcpFake('x'),
    [TOOL_SEARCH_TOOL_NAME]: mcpFake('search'),
  };
  const deferredNames = new Set(['mcp__gh__x']);
  const before = activeToolNames(tools, deferredNames, new Set());
  assert.equal(before.includes('mcp__gh__x'), false, 'deferred tool inactive until fetched');
  assert.ok(before.includes('readFile') && before.includes(TOOL_SEARCH_TOOL_NAME));
  assert.ok(before.includes(SUBMIT_TOOL_NAME), 'submit always active');
  const after = activeToolNames(tools, deferredNames, new Set(['mcp__gh__x']));
  assert.ok(after.includes('mcp__gh__x'), 'an activated deferred tool becomes active');
});

test('deferred loading end-to-end: an over-threshold MCP server surfaces name-only + tool_search on the Worker (issue #119)', async () => {
  const surplus: ToolSet = {
    create_issue: mcpFake('Create a GitHub issue.'),
    list_prs: mcpFake('List PRs.'),
  };
  const mcp = new McpClientManager({
    servers: { gh: { command: 'gh-mcp' } },
    deferToolsOver: 1, // 2 surplus tools > 1 → deferred
    createClient: (async () =>
      ({ tools: async () => surplus, close: async () => {} }) as never) as never,
  });
  await mcp.connectAll();
  const mount = mountDeferredTools(mcp.toolSurfaceForRole('worker'));
  // resolveWorkerTools fills the fixed slots (local, since the server supplies none); the surplus is
  // added by the mount — proving tools beyond the fixed slots now reach the Worker (dropped pre-#119).
  const workerTools: ToolSet = {
    ...resolveWorkerTools(mcp.toolsForRole('worker'), '/tmp/wt'),
    ...mount.extraTools,
  };
  assert.ok(TOOL_SEARCH_TOOL_NAME in workerTools, 'tool_search reaches the Worker');
  assert.ok(
    'mcp__gh__create_issue' in workerTools,
    'surplus tools reach the Worker (were dropped before #119)',
  );
  assert.ok('readFile' in workerTools, 'fixed slots still present');
  const active = activeToolNames(workerTools, mount.deferredNames, mount.activated ?? new Set());
  assert.equal(
    active.includes('mcp__gh__create_issue'),
    false,
    'deferred schema absent from active tools until fetched',
  );
  assert.ok(
    active.includes('readFile') && active.includes(SUBMIT_TOOL_NAME),
    'fixed slots + submit stay active',
  );
  await mcp.close();
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

test('runLoopAdapter: a completed run without abort never fires the reap listener', async () => {
  const { mcp, closes } = countingMcp();
  await mcp.connectAll();
  const { state } = makeState();

  const result = await runLoopAdapter(
    { ...makeInput(), signal: new AbortController().signal },
    seams({ state, makeMcp: () => mcp }),
  );

  assert.equal(result.kind, 'success');
  // A seam-provided MCP is owned by the caller (the adapter never connected it), so the normal path
  // leaves it open; only an abort reaps it. This guards the listener against firing unconditionally.
  assert.equal(closes(), 0, 'no abort → seam-owned MCP left untouched');
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

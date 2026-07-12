// Unit coverage for the production WorkLoop wiring. Every external dependency (Planner,
// Orchestrator, WorktreePool, GitHubClient, MCP, StateStore) is driven through the adapter's
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
  SYSTEM_REMINDER_CONTRACT,
} from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { RunLoopInput } from '../cli/commands.ts';
import { Credentials } from '../credentials/credentials.ts';
import { GitHubClient } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import type { Plan } from '../plan/schema.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import {
  type AdapterStatePort,
  branchFor,
  createRollingContextAccumulator,
  defaultMakeOrchestrator,
  exploreReadTools,
  githubThreadTool,
  harnessContextBlock,
  localEditTools,
  localReadTools,
  mcpTool,
  type PlanGroupsOutcome,
  persistRollingContext,
  planToPrGroups,
  type RunLoopAdapterSeams,
  reminderAgentSystemPrompt,
  resolvePlannerTools,
  resolveWorkerTools,
  runLoopAdapter,
  sanitizeBranchComponent,
  webSearchProviderOptions,
} from './run-loop-adapter.ts';
import type { WorkLoopGithub, WorkLoopOrchestrator, WorkLoopPool } from './work-loop.ts';

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

// Orchestrator stub whose Worker outcome is configurable; finalizeCommit / openPr / runReviewer
// are inert so the loop advances to the merge/awaiting state.
function makeOrchestrator(
  config: { worker?: WorkerResult; reviewer?: ReviewerResult; prNumber?: number } = {},
): WorkLoopOrchestrator {
  return {
    runWorker: async () => config.worker ?? { kind: 'ok', delivery: delivery() },
    finalizeCommit: async () => 'sha',
    openPr: async () => pr(config.prNumber ?? 1),
    runReviewer: async () => config.reviewer ?? { kind: 'ok', resolutions: [] },
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

function makePool(): WorkLoopPool {
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
    makePool: () => makePool(),
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
    runReviewer: async () => ({ kind: 'ok', resolutions: [] }),
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

test('localEditTools supplies worktree-scoped readFile/writeFile/bash (no-MCP fallback)', () => {
  // When no MCP server provides edit tools, the Worker/Reviewer fall back to these so a bare
  // `aitm start` can still edit, commit and open a PR (instead of blocking).
  const tools = localEditTools('/tmp/some-worktree');
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
  const mcp = { toolsForRole: () => ({}) };
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
  const orch = defaultMakeOrchestrator({ input, mcp, rollingContext: '' } as never);
  assert.equal(typeof orch.runWorker, 'function');

  const res = await orch.runWorker({
    group: group('core'),
    worktree: { path: '/tmp/wt' },
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

test('exploreReadTools exposes exactly the worktree-confined read trio', () => {
  const tools = exploreReadTools('/tmp/some-worktree');
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

test('resolvePlannerTools mounts explore only when the caller wires it', () => {
  const withExplore = resolvePlannerTools({}, '/tmp/repo', false, stubExplore());
  assert.equal('explore' in withExplore, true);
  const withoutExplore = resolvePlannerTools({}, '/tmp/repo');
  assert.equal('explore' in withoutExplore, false);
});

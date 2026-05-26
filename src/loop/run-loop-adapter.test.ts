// Unit coverage for the production WorkLoop wiring. Every external dependency (Planner,
// Orchestrator, WorktreePool, GitHubClient, MCP, StateStore) is driven through the adapter's
// seams so all four WorkLoopResult branches — success, awaiting-pr, blocked, session-cap —
// are reachable without spawning subagents, git, or `gh`. The integration suite covers the
// real stack end-to-end.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunLoopInput } from '../cli/commands.ts';
import { Credentials } from '../credentials/credentials.ts';
import { GitHubClient } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import type { Plan } from '../plan/schema.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import {
  type AdapterStatePort,
  githubThreadTool,
  NO_EDIT_TOOLS_REASON,
  type PlanGroupsOutcome,
  planToPrGroups,
  type RunLoopAdapterSeams,
  runLoopAdapter,
} from './run-loop-adapter.ts';
import type { WorkLoopGithub, WorkLoopOrchestrator, WorkLoopPool } from './work-loop.ts';

// ---- Fixtures --------------------------------------------------------------

function group(id: string, overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id,
    title: id,
    tasks: ['do thing'],
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
  };
}

function makeGithub(): WorkLoopGithub {
  return {
    defaultBranch: async () => 'main',
    waitForChecks: async () => 'success',
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
        tasks: [{ description: 'a' }, { description: 'b' }],
        dependsOn: [],
      },
      { id: 'api', title: 'API', tasks: [{ description: 'c' }], dependsOn: ['core'] },
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
      { id: 'core', branch: 'aitm/core', status: 'pending', tasks: ['a', 'b'], dependsOn: [] },
      { id: 'api', branch: 'aitm/api', status: 'pending', tasks: ['c'], dependsOn: ['core'] },
    ],
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

// ---- Default orchestrator bridge: no MCP edit tools → blocked --------------

test('default orchestrator blocks the group when no MCP edit tools are connected', async () => {
  const { state } = makeState();
  const result = await runLoopAdapter(makeInput({ autoMerge: false }), {
    // Real default orchestrator bridge; an unconnected MCP manager exposes no tools.
    state,
    planGroups: async () => ({ kind: 'ok', groups: [group('only')] }),
    makeMcp: () => new McpClientManager({ servers: {} }),
    makePool: () => makePool(),
    makeGithub: () => makeGithub(),
  });
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /No edit tools available/);
  assert.equal(NO_EDIT_TOOLS_REASON.includes('readFile'), true);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed } from '../github/errors.ts';
import type { MergeMethod } from '../github/github-client.ts';
import type { CheckStatus, PullRequest, ReviewThread } from '../github/schema.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import type { Worktree } from '../workspace/worktree-pool.ts';
import {
  WorkLoop,
  type WorkLoopDeps,
  type WorkLoopGithub,
  type WorkLoopGraph,
  type WorkLoopOrchestrator,
  type WorkLoopPool,
  type WorkLoopState,
} from './work-loop.ts';

// ---- Stubs ---------------------------------------------------------------

function group(id: string, overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id,
    title: id,
    tasks: ['t'],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    ...overrides,
  };
}

function delivery(): WorkerDelivery {
  return {
    branch: 'aitm/x',
    draftCommitMessage: 'feat: x',
    changes: [{ path: 'a.ts', kind: 'create', summary: 'created a' }],
    progressEntries: ['- did x'],
  };
}

function pullRequest(number: number, headRefName = 'aitm/x'): PullRequest {
  return {
    number,
    state: 'OPEN',
    url: `https://github.com/o/r/pull/${number}`,
    headRefName,
    baseRefName: 'main',
  };
}

function baseState(): RunState {
  return {
    status: 'working',
    prGroups: [],
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

type OrchestratorCalls = {
  runWorker: WorkerInvocationCall[];
  finalizeCommit: { group: PrGroup; worktreePath: string }[];
  openPr: { group: PrGroup; baseBranch: string }[];
  runReviewer: { pr: number; threads: ReviewThread[]; worktree: Worktree }[];
};

type WorkerInvocationCall = { group: PrGroup; worktree: Worktree; baseBranch: string };

function makeOrchestrator(
  config: {
    workerResults?: WorkerResult[];
    reviewerResult?: ReviewerResult;
    prNumber?: number;
    headRefName?: string;
  } = {},
): { orchestrator: WorkLoopOrchestrator; calls: OrchestratorCalls } {
  const calls: OrchestratorCalls = {
    runWorker: [],
    finalizeCommit: [],
    openPr: [],
    runReviewer: [],
  };
  const queue = (
    config.workerResults ?? [{ kind: 'ok', delivery: delivery() } as WorkerResult]
  ).slice();
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async (input) => {
      calls.runWorker.push(input);
      const next = queue.shift();
      if (!next) return { kind: 'ok', delivery: delivery() } as WorkerResult;
      return next;
    },
    finalizeCommit: async (g, _d, worktreePath) => {
      calls.finalizeCommit.push({ group: g, worktreePath });
      return `sha-${g.id}`;
    },
    openPr: async (g, _d, baseBranch) => {
      calls.openPr.push({ group: g, baseBranch });
      return pullRequest(config.prNumber ?? 42, config.headRefName ?? `aitm/${g.id}`);
    },
    runReviewer: async (input) => {
      calls.runReviewer.push(input);
      return config.reviewerResult ?? ({ kind: 'ok', resolutions: [] } satisfies ReviewerResult);
    },
  };
  return { orchestrator, calls };
}

type GithubCalls = {
  defaultBranch: number;
  waitForChecks: number[];
  listUnresolvedThreads: number[];
  mergePr: { pr: number; method: MergeMethod }[];
};

function makeGithub(
  config: {
    defaultBranch?: string;
    checks?: Array<CheckStatus | CiFailed>;
    threads?: ReviewThread[];
  } = {},
): { github: WorkLoopGithub; calls: GithubCalls } {
  const checks = (config.checks ?? ['success' as CheckStatus]).slice();
  const calls: GithubCalls = {
    defaultBranch: 0,
    waitForChecks: [],
    listUnresolvedThreads: [],
    mergePr: [],
  };
  const github: WorkLoopGithub = {
    defaultBranch: async () => {
      calls.defaultBranch++;
      return config.defaultBranch ?? 'main';
    },
    waitForChecks: async (pr) => {
      calls.waitForChecks.push(pr);
      const next = checks.shift();
      if (next instanceof CiFailed) throw next;
      return next ?? 'success';
    },
    listUnresolvedThreads: async (pr) => {
      calls.listUnresolvedThreads.push(pr);
      return config.threads ?? [];
    },
    mergePr: async (pr, method) => {
      calls.mergePr.push({ pr, method });
    },
  };
  return { github, calls };
}

type PoolCalls = { acquire: string[]; release: string[]; activeAtAcquire: number[] };

function makePool(): { pool: WorkLoopPool; calls: PoolCalls; live: () => number } {
  const live = new Set<string>();
  const calls: PoolCalls = { acquire: [], release: [], activeAtAcquire: [] };
  const pool: WorkLoopPool = {
    acquire: async (groupId, branch) => {
      calls.acquire.push(groupId);
      calls.activeAtAcquire.push(live.size);
      live.add(groupId);
      return { groupId, branch, path: `/tmp/wt/${groupId}` };
    },
    release: async (groupId) => {
      calls.release.push(groupId);
      live.delete(groupId);
    },
  };
  return { pool, calls, live: () => live.size };
}

function makeState(): { state: WorkLoopState; updates: RunState[] } {
  let current = baseState();
  const updates: RunState[] = [];
  const state: WorkLoopState = {
    update: async (mutator) => {
      current = mutator(current);
      updates.push(current);
      return current;
    },
  };
  return { state, updates };
}

function makeGraph(
  ready: PrGroup[],
  options: { completeAfter?: number } = {},
): { graph: WorkLoopGraph; readyCalls: number; completeCalls: number } {
  let readyCalls = 0;
  let completeCalls = 0;
  const completeAfter = options.completeAfter ?? 1;
  const graph: WorkLoopGraph = {
    ready: () => {
      readyCalls++;
      return ready.slice();
    },
    isComplete: () => {
      const done = completeCalls >= completeAfter;
      completeCalls++;
      return done;
    },
  };
  return {
    graph,
    get readyCalls() {
      return readyCalls;
    },
    get completeCalls() {
      return completeCalls;
    },
  };
}

function makeDeps(
  overrides: Partial<WorkLoopDeps> & {
    orchestrator?: WorkLoopOrchestrator;
    github?: WorkLoopGithub;
    state?: WorkLoopState;
    pool?: WorkLoopPool;
    graph?: WorkLoopGraph;
  } = {},
): WorkLoopDeps {
  const orch = overrides.orchestrator ?? makeOrchestrator().orchestrator;
  const gh = overrides.github ?? makeGithub().github;
  const st = overrides.state ?? makeState().state;
  const pl = overrides.pool ?? makePool().pool;
  const gr = overrides.graph ?? makeGraph([], { completeAfter: 0 }).graph;
  return {
    orchestrator: orch,
    github: gh,
    state: st,
    pool: pl,
    graph: gr,
    concurrency: overrides.concurrency ?? 1,
    autoMerge: overrides.autoMerge ?? true,
    maxSessions: overrides.maxSessions ?? null,
    ...(overrides.mergeMethod !== undefined ? { mergeMethod: overrides.mergeMethod } : {}),
    ...(overrides.initialSessionCount !== undefined
      ? { initialSessionCount: overrides.initialSessionCount }
      : {}),
  };
}

// ---- Tests ---------------------------------------------------------------

test('WorkLoop is constructible', () => {
  const loop = new WorkLoop(makeDeps());
  assert.ok(loop instanceof WorkLoop);
});

test('runGroup sequences: acquire → worker → finalizeCommit → openPr → state awaiting-pr', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { state, updates } = makeState();
  const { pool, calls: poolCalls } = makePool();
  const g = group('alpha');
  const loop = new WorkLoop(makeDeps({ orchestrator, state, pool, autoMerge: false }));
  await loop.runGroup(g);

  assert.deepEqual(poolCalls.acquire, ['alpha']);
  assert.deepEqual(poolCalls.release, ['alpha']);
  assert.equal(calls.runWorker.length, 1);
  assert.equal(calls.runWorker[0]?.group.id, 'alpha');
  assert.equal(calls.runWorker[0]?.group.branch, 'aitm/alpha');
  assert.equal(calls.finalizeCommit.length, 1);
  assert.equal(calls.finalizeCommit[0]?.worktreePath, '/tmp/wt/alpha');
  assert.equal(calls.openPr.length, 1);
  assert.equal(calls.openPr[0]?.baseBranch, 'main');

  // Test seeds no prGroups in baseState, so the map() is a no-op on group rows; the
  // assertion that matters here is that state.update was called twice (in-progress → awaiting-pr).
  assert.ok(updates.length >= 2, 'state.update called at least for in-progress + awaiting-pr');
});

test('runGroup persists status transitions to state for the matching group id', async () => {
  const { orchestrator } = makeOrchestrator({ prNumber: 9 });
  const initial: RunState = { ...baseState(), prGroups: [group('beta')] };
  let current = initial;
  const updates: RunState[] = [];
  const state: WorkLoopState = {
    update: async (mutator) => {
      current = mutator(current);
      updates.push(current);
      return current;
    },
  };
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(group('beta'));

  const beta = (s: RunState): PrGroup | undefined => s.prGroups.find((p) => p.id === 'beta');
  const statuses = updates.map((s) => beta(s)?.status);
  assert.deepEqual(statuses, ['in-progress', 'awaiting-pr']);
  assert.equal(beta(updates[updates.length - 1] as RunState)?.pr, 9);
  assert.equal(beta(updates[updates.length - 1] as RunState)?.branch, 'aitm/beta');
});

test('autoMerge: success path runs waitForChecks → mergePr and marks merged', async () => {
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 11 });
  const { github, calls: ghCalls } = makeGithub({ checks: ['success'], threads: [] });
  const initial = { ...baseState(), prGroups: [group('gamma')] };
  let current = initial;
  const updates: RunState[] = [];
  const state: WorkLoopState = {
    update: async (mutator) => {
      current = mutator(current);
      updates.push(current);
      return current;
    },
  };
  const loop = new WorkLoop(makeDeps({ orchestrator, github, state, autoMerge: true }));
  await loop.runGroup(group('gamma'));

  assert.deepEqual(ghCalls.waitForChecks, [11]);
  assert.deepEqual(ghCalls.mergePr, [{ pr: 11, method: 'squash' }]);
  assert.equal(orchCalls.runReviewer.length, 0, 'reviewer not invoked when no threads');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'gamma')?.status, 'merged');
});

test('autoMerge: CI failure triggers Worker fix then re-checks then merges', async () => {
  const { orchestrator, calls: orchCalls } = makeOrchestrator({
    prNumber: 33,
    workerResults: [
      { kind: 'ok', delivery: delivery() },
      { kind: 'ok', delivery: delivery() },
    ],
  });
  const { github, calls: ghCalls } = makeGithub({
    checks: [new CiFailed('tests failed'), 'success'],
  });
  const loop = new WorkLoop(makeDeps({ orchestrator, github, autoMerge: true }));
  await loop.runGroup(group('delta'));

  assert.equal(orchCalls.runWorker.length, 2, 'worker invoked twice: initial + fix');
  assert.equal(orchCalls.finalizeCommit.length, 2);
  assert.deepEqual(ghCalls.waitForChecks, [33, 33]);
  assert.deepEqual(ghCalls.mergePr, [{ pr: 33, method: 'squash' }]);
});

test('autoMerge: unresolved threads invoke Reviewer before merging', async () => {
  const thread: ReviewThread = {
    id: 't1',
    isResolved: false,
    path: 'a.ts',
    comments: [{ id: 'c1', body: 'nit', author: 'rev' }],
  };
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 5 });
  const { github, calls: ghCalls } = makeGithub({ threads: [thread] });
  const loop = new WorkLoop(makeDeps({ orchestrator, github, autoMerge: true }));
  await loop.runGroup(group('epsilon'));

  assert.equal(calls.runReviewer.length, 1);
  assert.deepEqual(calls.runReviewer[0]?.threads, [thread]);
  assert.deepEqual(ghCalls.mergePr, [{ pr: 5, method: 'squash' }]);
});

test('autoMerge: custom mergeMethod is honoured', async () => {
  const { orchestrator } = makeOrchestrator({ prNumber: 99 });
  const { github, calls } = makeGithub();
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, autoMerge: true, mergeMethod: 'rebase' }),
  );
  await loop.runGroup(group('zeta'));
  assert.deepEqual(calls.mergePr, [{ pr: 99, method: 'rebase' }]);
});

test('Worker blocked → group marked blocked, no PR opened', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    workerResults: [{ kind: 'blocked', reason: 'no plan' }],
  });
  const initial = { ...baseState(), prGroups: [group('eta')] };
  let current = initial;
  const updates: RunState[] = [];
  const state: WorkLoopState = {
    update: async (mutator) => {
      current = mutator(current);
      updates.push(current);
      return current;
    },
  };
  const loop = new WorkLoop(makeDeps({ orchestrator, state }));
  await loop.runGroup(group('eta'));

  assert.equal(calls.finalizeCommit.length, 0);
  assert.equal(calls.openPr.length, 0);
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'eta')?.status, 'blocked');
});

test('Worker error → group marked blocked', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    workerResults: [{ kind: 'error', error: 'boom' }],
  });
  const initial = { ...baseState(), prGroups: [group('theta')] };
  let current = initial;
  const updates: RunState[] = [];
  const state: WorkLoopState = {
    update: async (mutator) => {
      current = mutator(current);
      updates.push(current);
      return current;
    },
  };
  const loop = new WorkLoop(makeDeps({ orchestrator, state }));
  await loop.runGroup(group('theta'));

  assert.equal(calls.openPr.length, 0);
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'theta')?.status, 'blocked');
});

test('pool.release fires even when orchestrator throws', async () => {
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async () => {
      throw new Error('worker exploded');
    },
    finalizeCommit: async () => 'sha',
    openPr: async () => pullRequest(1),
    runReviewer: async () => ({ kind: 'ok', resolutions: [] }),
  };
  const { pool, calls } = makePool();
  const loop = new WorkLoop(makeDeps({ orchestrator, pool }));
  await loop.runGroup(group('iota'));
  assert.deepEqual(calls.release, ['iota']);
});

test('run sequences a single ready group end-to-end', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 21 });
  const g = group('only');
  const ready = makeGraph([g], { completeAfter: 1 });
  const loop = new WorkLoop(makeDeps({ orchestrator, graph: ready.graph, autoMerge: true }));
  const result = await loop.run();
  assert.equal(result.kind, 'success');
  assert.equal(calls.runWorker.length, 1);
  assert.equal(calls.openPr.length, 1);
});

test('concurrency cap limits batch size; subsequent passes pull next ready set', async () => {
  // Three ready groups, concurrency=2. First pass runs 2, second pass runs 1.
  const groups = [group('g1'), group('g2'), group('g3')];
  let pass = 0;
  const graph: WorkLoopGraph = {
    ready: () => {
      pass++;
      if (pass === 1) return groups.slice();
      if (pass === 2) return [groups[2] as PrGroup];
      return [];
    },
    isComplete: () => pass >= 3,
  };
  const { orchestrator, calls } = makeOrchestrator();
  const { pool, calls: poolCalls } = makePool();
  const loop = new WorkLoop(
    makeDeps({ orchestrator, graph, pool, concurrency: 2, autoMerge: true }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'success');
  assert.equal(calls.runWorker.length, 3, 'all three groups processed');
  // Pool tracks live size at the moment of acquire — in the 2-concurrent pass the
  // second acquire observes the first as still live (size 1), proving they overlapped.
  assert.ok(
    poolCalls.activeAtAcquire.slice(0, 2).some((n) => n === 1),
    `expected at least one overlap in first batch, got ${poolCalls.activeAtAcquire.join(',')}`,
  );
  // Third acquire fires after both first-batch releases, so live=0 at that moment.
  assert.equal(poolCalls.activeAtAcquire[2], 0);
});

test('blocked propagation: WorkLoopResult.kind === "blocked" with reason from worker', async () => {
  const { orchestrator } = makeOrchestrator({
    workerResults: [{ kind: 'blocked', reason: 'cannot plan' }],
  });
  const ready = makeGraph([group('bad')], { completeAfter: 1 });
  const loop = new WorkLoop(makeDeps({ orchestrator, graph: ready.graph }));
  const result = await loop.run();
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /bad/);
    assert.match(result.reason, /cannot plan/);
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0]?.status, 'blocked');
  }
});

test('session cap exits with "session-cap" before all groups are processed', async () => {
  // 3 ready groups, concurrency=3, maxSessions=2 → only 2 run, then cap fires.
  const groups = [group('a'), group('b'), group('c')];
  let pass = 0;
  const graph: WorkLoopGraph = {
    ready: () => {
      pass++;
      return groups.slice(pass - 1);
    },
    isComplete: () => pass > 5,
  };
  const { orchestrator, calls } = makeOrchestrator();
  const loop = new WorkLoop(
    makeDeps({ orchestrator, graph, concurrency: 3, maxSessions: 2, autoMerge: true }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'session-cap');
  assert.equal(calls.runWorker.length, 2, 'only 2 worker invocations under cap');
});

test('autoMerge=false → result is awaiting-pr with PR numbers', async () => {
  const { orchestrator } = makeOrchestrator({ prNumber: 77 });
  const ready = makeGraph([group('p')], { completeAfter: 1 });
  const loop = new WorkLoop(makeDeps({ orchestrator, graph: ready.graph, autoMerge: false }));
  const result = await loop.run();
  assert.equal(result.kind, 'awaiting-pr');
  if (result.kind === 'awaiting-pr') {
    assert.deepEqual(result.prs, [77]);
  }
});

test('run exits immediately when graph.isComplete() is already true', async () => {
  const graph: WorkLoopGraph = {
    ready: () => [],
    isComplete: () => true,
  };
  const { orchestrator, calls } = makeOrchestrator();
  const loop = new WorkLoop(makeDeps({ orchestrator, graph }));
  const result = await loop.run();
  assert.equal(result.kind, 'success');
  assert.equal(calls.runWorker.length, 0);
});

test('run breaks out when ready is empty but graph not complete (stuck)', async () => {
  // Defensive: protects against infinite loops if production stub fails to advance graph state.
  const graph: WorkLoopGraph = {
    ready: () => [],
    isComplete: () => false,
  };
  const loop = new WorkLoop(makeDeps({ graph }));
  const result = await loop.run();
  assert.equal(result.kind, 'success');
});

test('markStatus does not increment persisted sessionCount (status transitions are not sessions)', async () => {
  const { orchestrator } = makeOrchestrator({ prNumber: 1 });
  const { state, updates } = makeState();
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(group('m'));
  // Three update calls in this path: in-progress, awaiting-pr — none should touch sessionCount.
  for (const s of updates) {
    assert.equal(s.sessionCount, 0, 'markStatus must not bump sessionCount');
  }
});

test('run() bumps persisted sessionCount once per batch, by batch.length', async () => {
  const groups = [group('a'), group('b'), group('c')];
  let pass = 0;
  const graph: WorkLoopGraph = {
    ready: () => {
      pass++;
      if (pass === 1) return groups.slice();
      return [];
    },
    isComplete: () => pass >= 2,
  };
  const { orchestrator } = makeOrchestrator();
  const { state, updates } = makeState();
  const loop = new WorkLoop(
    makeDeps({ orchestrator, state, graph, concurrency: 3, autoMerge: true }),
  );
  await loop.run();
  // First state update is the session-count bump (+3), preceding any group's in-progress write.
  const sessionBumps = updates.filter(
    (s, i) => i === 0 || s.sessionCount !== updates[i - 1]?.sessionCount,
  );
  assert.equal(sessionBumps.length, 1, 'sessionCount mutated exactly once');
  const last = updates[updates.length - 1];
  assert.equal(last?.sessionCount, 3, 'final persisted sessionCount equals batch size');
});

test('initialSessionCount seeds the in-memory counter so resume respects maxSessions', async () => {
  // maxSessions=2, initialSessionCount=2 → cap is already reached, no work done.
  const ready = makeGraph([group('x'), group('y')], { completeAfter: 5 });
  const { orchestrator, calls } = makeOrchestrator();
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      graph: ready.graph,
      concurrency: 2,
      maxSessions: 2,
      initialSessionCount: 2,
    }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'session-cap');
  assert.equal(calls.runWorker.length, 0, 'no worker invoked when seeded counter already hit cap');
});

test('state write failure after openPr → loop yields awaiting-pr outcome, not blocked', async () => {
  const { orchestrator } = makeOrchestrator({ prNumber: 77 });
  let callCount = 0;
  const state: WorkLoopState = {
    update: async (mutator) => {
      callCount++;
      // call 1: incrementSessionCount, call 2: in-progress, call 3: awaiting-pr (fail here)
      if (callCount === 3) throw new Error('disk full');
      return mutator(baseState());
    },
  };
  const ready = makeGraph([group('nu')], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, state, graph: ready.graph, autoMerge: false }),
  );
  const result = await loop.run();

  assert.equal(result.outcomes.length, 1);
  assert.equal(
    result.outcomes[0]?.status,
    'awaiting-pr',
    'external success preserved despite state write failure',
  );
  if (result.outcomes[0]?.status === 'awaiting-pr') {
    assert.equal(result.outcomes[0].pr, 77);
  }
  assert.notEqual(result.kind, 'blocked', 'result must not flip to blocked');
});

test('state write failure after mergePr → outcome stays merged', async () => {
  const { orchestrator } = makeOrchestrator({ prNumber: 88 });
  let callCount = 0;
  const state: WorkLoopState = {
    update: async (mutator) => {
      callCount++;
      // calls: 1 sessionCount, 2 in-progress, 3 awaiting-pr, 4 merged (fail here)
      if (callCount === 4) throw new Error('disk full');
      return mutator(baseState());
    },
  };
  const ready = makeGraph([group('xi')], { completeAfter: 1 });
  const loop = new WorkLoop(makeDeps({ orchestrator, state, graph: ready.graph, autoMerge: true }));
  const result = await loop.run();

  assert.equal(result.outcomes.length, 1);
  assert.equal(
    result.outcomes[0]?.status,
    'merged',
    'merge outcome preserved despite state write failure',
  );
  assert.notEqual(result.kind, 'blocked');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed } from '../github/errors.ts';
import type { CiResult, MergeMethod } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import { renderPlanMarkdown } from '../plan/plan-markdown.ts';
import type { PrGroup, RunState, Task } from '../state/schema.ts';
import type { WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import { DirtyWorkingTree } from '../workspace/dirty-tree.ts';
import type { Checkout } from '../workspace/in-place-checkout.ts';
import { DEFAULT_MAX_CI_FIX_ATTEMPTS } from './constants.ts';
import type { SelfReviewResult } from './self-review.ts';
import type { StageWorkResult } from './stage-handlers.ts';
import {
  alreadyCommittedDelivery,
  type BudgetStatus,
  type CheckoutHome,
  ciFixFailedError,
  describeError,
  mergeDeliveries,
  noChangesDelivery,
  recoveredDelivery,
  reviewFailedError,
  type SelfReviewInvocation,
  WorkLoop,
  type WorkLoopDeps,
  type WorkLoopGithub,
  type WorkLoopGraph,
  type WorkLoopOrchestrator,
  type WorkLoopPrContext,
  type WorkLoopState,
} from './work-loop.ts';

// ---- Stubs ---------------------------------------------------------------

function group(id: string, overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id,
    title: id,
    tasks: [{ id: 't1', text: 't', complexity: 'normal', done: false }],
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
  finalizeCommit: { group: PrGroup; checkoutPath: string; taskId?: string }[];
  openPr: { group: PrGroup; baseBranch: string; delivery: WorkerDelivery }[];
  runCiFix: { group: PrGroup; pr: number; baseBranch: string }[];
  addressReviews: { pr: number; threads: ReviewThread[] }[];
  selfReview: SelfReviewInvocation[];
  releaseGroup: string[];
};

type WorkerInvocationCall = {
  group: PrGroup;
  task?: Task;
  checkout: Checkout;
  baseBranch: string;
  signal?: AbortSignal;
};

function makeOrchestrator(
  config: {
    workerResults?: WorkerResult[];
    ciFixResults?: StageWorkResult[];
    addressReviewsResult?: StageWorkResult;
    prNumber?: number;
    headRefName?: string;
    // Attach the optional selfReview port method (default: omitted, so maybeSelfReview no-ops and the
    // flow is byte-identical to the pre-selfReview behavior). `selfReviewResult` scripts its outcome;
    // `selfReviewImpl` fully overrides it (e.g. to throw).
    selfReview?: boolean;
    selfReviewResult?: SelfReviewResult;
    selfReviewImpl?: (input: SelfReviewInvocation) => Promise<SelfReviewResult>;
    // Shared ordering log so a test can assert reset/openPr/merge interleaving across stubs.
    events?: string[];
  } = {},
): { orchestrator: WorkLoopOrchestrator; calls: OrchestratorCalls } {
  const calls: OrchestratorCalls = {
    runWorker: [],
    finalizeCommit: [],
    openPr: [],
    runCiFix: [],
    addressReviews: [],
    selfReview: [],
    releaseGroup: [],
  };
  const queue = (
    config.workerResults ?? [{ kind: 'ok', delivery: delivery() } as WorkerResult]
  ).slice();
  const ciFixQueue = (config.ciFixResults ?? []).slice();
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async (input) => {
      calls.runWorker.push(input);
      const next = queue.shift();
      if (!next) return { kind: 'ok', delivery: delivery() } as WorkerResult;
      return next;
    },
    finalizeCommit: async (g, _d, checkoutPath, taskId) => {
      calls.finalizeCommit.push({ group: g, checkoutPath, ...(taskId ? { taskId } : {}) });
      return `sha-${g.id}`;
    },
    openPr: async (g, d, baseBranch) => {
      calls.openPr.push({ group: g, baseBranch, delivery: d });
      config.events?.push(`openPr:${g.branch}`);
      return pullRequest(config.prNumber ?? 42, config.headRefName ?? `aitm/${g.id}`);
    },
    runCiFix: async ({ group, pr, baseBranch }) => {
      calls.runCiFix.push({ group, pr, baseBranch });
      return ciFixQueue.shift() ?? { kind: 'ok' };
    },
    addressReviews: async ({ pr, threads }) => {
      calls.addressReviews.push({ pr, threads });
      return config.addressReviewsResult ?? { kind: 'ok' };
    },
    releaseGroup: (groupId) => {
      calls.releaseGroup.push(groupId);
    },
    ...(config.selfReview || config.selfReviewImpl || config.selfReviewResult
      ? {
          selfReview: async (input: SelfReviewInvocation) => {
            calls.selfReview.push(input);
            config.events?.push(`selfReview:${input.group.branch ?? input.group.id}`);
            if (config.selfReviewImpl) return config.selfReviewImpl(input);
            return config.selfReviewResult ?? ({ kind: 'clean' } satisfies SelfReviewResult);
          },
        }
      : {}),
  };
  return { orchestrator, calls };
}

// In-memory addressed-threads store so the addressing-reviews loop dedups (and thus terminates)
// in tests that drive it. Mirrors PrContextStore's read/record semantics.
function makeAddressedStore(): WorkLoopPrContext {
  const byPr = new Map<number, Set<string>>();
  return {
    readAddressedThreads: async (pr) => new Set(byPr.get(pr) ?? []),
    recordAddressedThreads: async (pr, ids) => {
      const set = byPr.get(pr) ?? new Set<string>();
      for (const id of ids) set.add(id);
      byPr.set(pr, set);
    },
  };
}

type GithubCalls = {
  defaultBranch: number;
  waitForChecks: number[];
  listUnresolvedThreads: number[];
  mergePr: { pr: number; method: MergeMethod }[];
};

const ciSuccess: CiResult = { state: 'success', failedChecks: [] };
const ciFailure: CiResult = {
  state: 'failure',
  failedChecks: [{ name: 'test', status: 'failure' }],
};

function makeGithub(
  config: {
    defaultBranch?: string;
    checks?: Array<CiResult | CiFailed>;
    threads?: ReviewThread[];
    // Login the addressing-reviews dedup treats as ours: a thread already carrying a comment from it
    // is skipped as already-replied. Unset → authenticatedLogin omitted (dedup falls back to record).
    botLogin?: string;
    // Shared ordering log (see makeOrchestrator).
    events?: string[];
  } = {},
): { github: WorkLoopGithub; calls: GithubCalls } {
  const checks = (config.checks ?? [ciSuccess]).slice();
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
      return next ?? ciSuccess;
    },
    listUnresolvedThreads: async (pr) => {
      calls.listUnresolvedThreads.push(pr);
      return config.threads ?? [];
    },
    mergePr: async (pr, method) => {
      calls.mergePr.push({ pr, method });
      config.events?.push(`merge:${pr}`);
    },
    ...(config.botLogin !== undefined
      ? { authenticatedLogin: async () => config.botLogin ?? '' }
      : {}),
  };
  return { github, calls };
}

type HomeCalls = {
  acquire: string[];
  release: string[];
  activeAtAcquire: number[];
  resetToBase: { groupId: string; branch: string; baseBranch: string }[];
  hasTaskCommit: { branch: string; taskId: string }[];
};

// `resetToBase: true` mounts the base-fresh-per-task seam so prPerTask + autoMerge branches each task
// off the merged base; omitted (default) leaves the home without it, exercising the single-branch
// fallback. `alreadyCommittedTaskIds` mounts hasTaskCommit, reporting true for exactly those task
// ids (the resume-idempotency skip); omitted leaves the home without it, exercising the pre-fix
// always-re-run-the-Worker fallback. `events` is a shared ordering log across stubs.
function makeHome(
  opts: { resetToBase?: boolean; alreadyCommittedTaskIds?: string[]; events?: string[] } = {},
): {
  home: CheckoutHome;
  calls: HomeCalls;
  live: () => number;
} {
  const live = new Set<string>();
  const calls: HomeCalls = {
    acquire: [],
    release: [],
    activeAtAcquire: [],
    resetToBase: [],
    hasTaskCommit: [],
  };
  const home: CheckoutHome = {
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
    ...(opts.alreadyCommittedTaskIds
      ? {
          hasTaskCommit: async (branch: string, taskId: string) => {
            calls.hasTaskCommit.push({ branch, taskId });
            return (opts.alreadyCommittedTaskIds ?? []).includes(taskId);
          },
        }
      : {}),
    ...(opts.resetToBase
      ? {
          // A real METHOD (not an arrow) that touches `this` — so if the WorkLoop extracts a bare
          // `home.resetToBase` reference and calls it detached, `this` is undefined and this throws,
          // exactly like the real InPlaceCheckout (which reads `this.current`). Guards the
          // `this`-binding regression that shipped once and blocked every group live.
          async resetToBase(
            this: CheckoutHome,
            groupId: string,
            branch: string,
            baseBranch: string,
          ) {
            void this.acquire;
            calls.resetToBase.push({ groupId, branch, baseBranch });
            opts.events?.push(`reset:${branch}`);
            return { groupId, branch, path: `/tmp/wt/${groupId}` };
          },
        }
      : {}),
  };
  return { home, calls, live: () => live.size };
}

function makeState(seed: PrGroup[] = []): {
  state: WorkLoopState;
  updates: RunState[];
  plans: string[];
} {
  let current: RunState = { ...baseState(), prGroups: seed };
  const updates: RunState[] = [];
  const plans: string[] = [];
  const state: WorkLoopState = {
    update: async (mutator) => {
      current = mutator(current);
      updates.push(current);
      return current;
    },
    writePlan: async (groups) => {
      plans.push(renderPlanMarkdown(groups));
    },
  };
  return { state, updates, plans };
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
    home?: CheckoutHome;
    graph?: WorkLoopGraph;
  } = {},
): WorkLoopDeps {
  const orch = overrides.orchestrator ?? makeOrchestrator().orchestrator;
  const gh = overrides.github ?? makeGithub().github;
  const st = overrides.state ?? makeState().state;
  const pl = overrides.home ?? makeHome().home;
  const gr = overrides.graph ?? makeGraph([], { completeAfter: 0 }).graph;
  return {
    orchestrator: orch,
    github: gh,
    state: st,
    home: pl,
    graph: gr,
    concurrency: overrides.concurrency ?? 1,
    autoMerge: overrides.autoMerge ?? true,
    maxSessions: overrides.maxSessions ?? null,
    ...(overrides.maxCiFixAttempts !== undefined
      ? { maxCiFixAttempts: overrides.maxCiFixAttempts }
      : {}),
    // No-op sleep so the post-CI review grace (handleWaitingCi) doesn't block on a real 2-min timer.
    sleep: overrides.sleep ?? (async () => {}),
    ...(overrides.progress !== undefined ? { progress: overrides.progress } : {}),
    ...(overrides.prContext !== undefined ? { prContext: overrides.prContext } : {}),
    ...(overrides.selfReview !== undefined ? { selfReview: overrides.selfReview } : {}),
    ...(overrides.prPerTask !== undefined ? { prPerTask: overrides.prPerTask } : {}),
    ...(overrides.adminMerge !== undefined ? { adminMerge: overrides.adminMerge } : {}),
    ...(overrides.mergeMethod !== undefined ? { mergeMethod: overrides.mergeMethod } : {}),
    ...(overrides.initialSessionCount !== undefined
      ? { initialSessionCount: overrides.initialSessionCount }
      : {}),
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
  };
}

// Fake clock that advances by `stepMs` on every read — deterministic, monotonic, and independent
// of wall-clock speed, so timing-line assertions never flake.
function steppedClock(stepMs: number): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

// ---- Tests ---------------------------------------------------------------

test('run: a crossed cost/token ceiling stops before the next group and blocks with the reason (issue #190)', async () => {
  const ready = makeGraph([twoTaskGroup()], { completeAfter: 1 });
  let budgetCalls = 0;
  const loop = new WorkLoop(
    makeDeps({
      graph: ready.graph,
      budget: async () => {
        budgetCalls++;
        return { exceeded: true, reason: 'token ceiling reached (1100 ≥ maxTotalTokens 1000)' };
      },
    }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /token ceiling/);
  assert.equal(budgetCalls, 1, 'the budget was consulted at the group boundary');
  // Checked BEFORE graph.ready(): no group is dispatched, so nothing lands mid-commit.
  assert.equal(ready.readyCalls, 0, 'no group was dispatched');
});

test('run: an abort during the pending budget lookup reports cancelled, not blocked (issue #190)', async () => {
  const controller = new AbortController();
  const ready = makeGraph([twoTaskGroup()], { completeAfter: 1 });
  // Model the real ordering: budget() is genuinely in flight (pending) when the SIGINT lands.
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  let releaseBudget!: (status: BudgetStatus) => void;
  const pending = new Promise<BudgetStatus>((resolve) => {
    releaseBudget = resolve;
  });
  const loop = new WorkLoop(
    makeDeps({
      graph: ready.graph,
      signal: controller.signal,
      budget: () => {
        lookupStarted();
        return pending;
      },
    }),
  );
  const runResult = loop.run();
  await started; // the ledger lookup is now in flight
  controller.abort(); // SIGINT arrives while it is still pending
  releaseBudget({ exceeded: true, reason: 'ceiling reached' });
  const result = await runResult;
  // Cancellation (exit 2) wins over the budget block (exit 1); nothing is dispatched.
  assert.equal(result.kind, 'cancelled');
  assert.equal(ready.readyCalls, 0, 'no group was dispatched');
});

test('run: a budget under the ceiling lets the loop dispatch the next group (issue #190)', async () => {
  const ready = makeGraph([twoTaskGroup()], { completeAfter: 1 });
  let budgetCalls = 0;
  const loop = new WorkLoop(
    makeDeps({
      autoMerge: false,
      graph: ready.graph,
      budget: async () => {
        budgetCalls++;
        return { exceeded: false };
      },
    }),
  );
  await loop.run();
  assert.equal(budgetCalls, 1, 'the budget was consulted');
  // A non-exceeding budget does not short-circuit — the loop proceeds to dispatch (graph.ready()).
  assert.ok(ready.readyCalls >= 1, 'the loop proceeded past the budget check');
});

test('WorkLoop is constructible', () => {
  const loop = new WorkLoop(makeDeps());
  assert.ok(loop instanceof WorkLoop);
});

test('runGroup sequences: acquire → worker → finalizeCommit → openPr → state awaiting-pr', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { state, updates } = makeState();
  const { home, calls: homeCalls } = makeHome();
  const g = group('alpha');
  const loop = new WorkLoop(makeDeps({ orchestrator, state, home, autoMerge: false }));
  await loop.runGroup(g);

  assert.deepEqual(homeCalls.acquire, ['alpha']);
  assert.deepEqual(homeCalls.release, ['alpha']);
  assert.equal(calls.runWorker.length, 1);
  assert.equal(calls.runWorker[0]?.group.id, 'alpha');
  assert.equal(calls.runWorker[0]?.group.branch, 'aitm/alpha');
  assert.equal(calls.finalizeCommit.length, 1);
  assert.equal(calls.finalizeCommit[0]?.checkoutPath, '/tmp/wt/alpha');
  assert.equal(calls.openPr.length, 1);
  assert.equal(calls.openPr[0]?.baseBranch, 'main');

  // Test seeds no prGroups in baseState, so the map() is a no-op on group rows; the
  // assertion that matters here is that state.update was called twice (in-progress → awaiting-pr).
  assert.ok(updates.length >= 2, 'state.update called at least for in-progress + awaiting-pr');
});

test('runGroup: releases the group on every terminal path — merged, blocked, and rethrown', async () => {
  // The orchestrator caches a full Worker conversation (and a CI-fix handle) per group; a group the
  // loop is done with is never rescheduled, so releaseGroup is what stops those piling up for the
  // whole run. It rides runGroup's finally, so every exit reports exactly once.
  const merged = makeOrchestrator({ prNumber: 7 });
  await new WorkLoop(makeDeps({ orchestrator: merged.orchestrator })).runGroup(group('alpha'));
  assert.deepEqual(merged.calls.releaseGroup, ['alpha'], 'released after the group merges');

  const blocked = makeOrchestrator({ workerResults: [{ kind: 'blocked', reason: 'no plan' }] });
  await new WorkLoop(makeDeps({ orchestrator: blocked.orchestrator, autoMerge: false })).runGroup(
    group('beta'),
  );
  assert.deepEqual(blocked.calls.releaseGroup, ['beta'], 'released after the group blocks');

  // A run precondition (dirty tree) rethrows past runGroup's catch — the finally still runs.
  const aborted = makeOrchestrator();
  const home: CheckoutHome = {
    acquire: () => Promise.reject(new DirtyWorkingTree('/repo', [' M src/a.ts'])),
    release: async () => {},
  };
  await assert.rejects(
    () =>
      new WorkLoop(makeDeps({ orchestrator: aborted.orchestrator, home })).runGroup(group('gamma')),
    DirtyWorkingTree,
  );
  assert.deepEqual(aborted.calls.releaseGroup, ['gamma'], 'released even when the run aborts');
});

test('self-review runs before openPr (group mode) with the delivery + checkout', async () => {
  const events: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7, selfReview: true, events });
  const loop = new WorkLoop(makeDeps({ orchestrator, autoMerge: false }));
  await loop.runGroup(group('alpha'));

  assert.equal(calls.selfReview.length, 1, 'self-review ran once');
  assert.equal(calls.selfReview[0]?.group.branch, 'aitm/alpha');
  assert.equal(calls.selfReview[0]?.baseBranch, 'main');
  assert.equal(calls.selfReview[0]?.checkout.path, '/tmp/wt/alpha');
  assert.ok(calls.selfReview[0]?.delivery, 'the just-produced delivery is handed to the review');
  // Order: the review must precede the PR open at the same branch.
  assert.deepEqual(events, ['selfReview:aitm/alpha', 'openPr:aitm/alpha']);
});

test('self-review is skipped byte-for-byte when the run disables it (selfReview:false)', async () => {
  const events: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7, selfReview: true, events });
  const loop = new WorkLoop(makeDeps({ orchestrator, autoMerge: false, selfReview: false }));
  await loop.runGroup(group('alpha'));

  assert.equal(calls.selfReview.length, 0, 'self-review never invoked');
  assert.equal(calls.openPr.length, 1, 'the PR still opens');
  assert.deepEqual(events, ['openPr:aitm/alpha'], 'no self-review event precedes openPr');
});

test('self-review no-ops when the orchestrator omits the method (PR opens as before)', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const loop = new WorkLoop(makeDeps({ orchestrator, autoMerge: false }));
  await loop.runGroup(group('alpha'));
  assert.equal(calls.selfReview.length, 0);
  assert.equal(calls.openPr.length, 1);
});

test('self-review is a safety net: a throw is swallowed and the PR still opens', async () => {
  const progress: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    selfReviewImpl: async () => {
      throw new Error('review boom');
    },
  });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, autoMerge: false, progress: (m) => progress.push(m) }),
  );
  await loop.runGroup(group('alpha'));

  assert.equal(calls.selfReview.length, 1);
  assert.equal(calls.openPr.length, 1, 'the PR opens despite the review throwing');
  assert.ok(
    progress.some((p) => /self-review errored \(review boom\)/.test(p)),
    'the error is surfaced on the progress stream',
  );
});

test('self-review runs before each per-task openPr (prPerTask mode)', async () => {
  const events: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7, selfReview: true, events });
  const loop = new WorkLoop(makeDeps({ orchestrator, autoMerge: false, prPerTask: true }));
  await loop.runGroup(group('alpha'));

  assert.equal(calls.selfReview.length, 1);
  assert.deepEqual(events, ['selfReview:aitm/alpha', 'openPr:aitm/alpha']);
});

test('self-review "unclean" outcome still opens the PR and records the reason on progress', async () => {
  const progress: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    selfReviewResult: { kind: 'unclean', reason: 'typecheck still red' },
  });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, autoMerge: false, progress: (m) => progress.push(m) }),
  );
  await loop.runGroup(group('alpha'));

  assert.equal(calls.openPr.length, 1);
  assert.ok(progress.some((p) => /could not fully clean the diff \(typecheck still red\)/.test(p)));
});

test('self-review "error" outcome still opens the PR and is surfaced distinctly (not as clean)', async () => {
  const progress: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    selfReviewResult: { kind: 'error', reason: 'provider 503: upstream timeout' },
  });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, autoMerge: false, progress: (m) => progress.push(m) }),
  );
  await loop.runGroup(group('alpha'));

  assert.equal(calls.openPr.length, 1, 'a review that never ran still opens the PR (non-fatal)');
  assert.ok(
    progress.some((p) => /self-review errored \(provider 503: upstream timeout\)/.test(p)),
    'the review error reads as errored, never as clean',
  );
  assert.ok(
    !progress.some((p) => /self-review clean/.test(p)),
    'an errored review must not emit the clean line',
  );
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
  // The per-task completion write keeps status 'in-progress' while flipping task.done, so dedupe
  // consecutive statuses to assert the transition sequence.
  const statuses = updates.map((s) => beta(s)?.status);
  const transitions = statuses.filter((st, i) => st !== statuses[i - 1]);
  assert.deepEqual(transitions, ['in-progress', 'awaiting-pr']);
  assert.equal(beta(updates[updates.length - 1] as RunState)?.pr, 9);
  assert.equal(beta(updates[updates.length - 1] as RunState)?.branch, 'aitm/beta');
  assert.equal(beta(updates[updates.length - 1] as RunState)?.tasks[0]?.done, true);
});

test('processGroup runs each undone task in order, marks done, re-renders plan.md', async () => {
  const multi = group('multi', {
    tasks: [
      { id: 'a', text: 'first task', complexity: 'normal', done: false },
      { id: 'b', text: 'second task', complexity: 'complex', done: false },
    ],
  });
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { state, updates, plans } = makeState([multi]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(multi);

  // One Worker pass per task, in order, each scoped to its own task.
  assert.equal(calls.runWorker.length, 2);
  assert.deepEqual(
    calls.runWorker.map((c) => c.task?.id),
    ['a', 'b'],
  );
  assert.equal(calls.finalizeCommit.length, 2);
  // PR opens once, after the final task (group-as-PR default).
  assert.equal(calls.openPr.length, 1);

  // Both tasks marked done in persisted state.
  const last = updates[updates.length - 1] as RunState;
  assert.deepEqual(
    last.prGroups.find((g) => g.id === 'multi')?.tasks.map((t) => t.done),
    [true, true],
  );

  // plan.md re-rendered per task; the final render shows both tasks checked.
  assert.ok(plans.length >= 2, 'plan.md re-rendered after each task');
  const finalPlan = plans[plans.length - 1] as string;
  assert.match(finalPlan, /## Group: multi/);
  assert.match(finalPlan, /- \[x\] \[NORMAL\] first task/);
  assert.match(finalPlan, /- \[x\] \[COMPLEX\] second task/);
});

test('resume: tasks already marked done are skipped', async () => {
  const resumed = group('resume', {
    tasks: [
      { id: 'a', text: 'already done', complexity: 'normal', done: true },
      { id: 'b', text: 'still pending', complexity: 'normal', done: false },
    ],
  });
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 5 });
  const { state, updates } = makeState([resumed]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(resumed);

  // Only the undone task runs.
  assert.equal(calls.runWorker.length, 1);
  assert.equal(calls.runWorker[0]?.task?.id, 'b');
  assert.equal(calls.finalizeCommit.length, 1);

  const last = updates[updates.length - 1] as RunState;
  assert.deepEqual(
    last.prGroups.find((g) => g.id === 'resume')?.tasks.map((t) => t.done),
    [true, true],
  );
});

test('resume idempotency: a task whose commit already landed (hasTaskCommit) skips the Worker and is marked done', async () => {
  // Models the crash window between finalizeCommit landing the commit and completeTask persisting
  // `done` — state still shows the task undone, but the branch (checked via home.hasTaskCommit)
  // already carries its commit. runOneTask must skip straight to completeTask, not re-run the Worker
  // (which would double the commit).
  const resumed = group('resume-commit', {
    tasks: [
      { id: 'a', text: 'already committed pre-crash', complexity: 'normal', done: false },
      { id: 'b', text: 'still pending', complexity: 'normal', done: false },
    ],
  });
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 5 });
  const { home, calls: homeCalls } = makeHome({ alreadyCommittedTaskIds: ['a'] });
  const { state, updates } = makeState([resumed]);
  const loop = new WorkLoop(makeDeps({ orchestrator, home, state, autoMerge: false }));
  await loop.runGroup(resumed);

  // Both tasks are checked; only the still-pending one runs the Worker.
  assert.deepEqual(
    homeCalls.hasTaskCommit.map((c) => c.taskId),
    ['a', 'b'],
  );
  assert.equal(calls.runWorker.length, 1, 'the already-committed task must not re-run the Worker');
  assert.equal(calls.runWorker[0]?.task?.id, 'b');
  assert.equal(calls.finalizeCommit.length, 1, 'no second commit for the already-committed task');

  const last = updates[updates.length - 1] as RunState;
  assert.deepEqual(
    last.prGroups.find((g) => g.id === 'resume-commit')?.tasks.map((t) => t.done),
    [true, true],
    'the already-committed task is marked done despite never re-running the Worker',
  );
});

test('resume idempotency: finalizeCommit receives the task id so a stamped commit can be detected on a later resume', async () => {
  const single = group('stamp', {
    tasks: [{ id: 't1', text: 'do the thing', complexity: 'normal', done: false }],
  });
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 9 });
  const { state } = makeState([single]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(single);

  assert.equal(calls.finalizeCommit.length, 1);
  assert.equal(calls.finalizeCommit[0]?.taskId, 't1');
});

test('resume: group persisted at waiting-ci skips Worker and opens no new PR', async () => {
  // A run that crashed after persisting waiting-ci resumes directly at CI polling.
  // handleWorking and handlePrOpen must NOT be called again.
  const resumed = group('resume-ci', {
    stage: 'waiting-ci',
    pr: 5,
    status: 'awaiting-pr',
    tasks: [{ id: 't1', text: 't', complexity: 'normal', done: true }],
  });
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 5 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [] });
  const { state } = makeState([resumed]);
  const loop = new WorkLoop(makeDeps({ orchestrator, github, state, autoMerge: true }));
  await loop.runGroup(resumed);

  assert.equal(orchCalls.runWorker.length, 0, 'Worker not re-run on resume at waiting-ci');
  assert.equal(orchCalls.openPr.length, 0, 'PR not re-opened on resume');
  assert.deepEqual(ghCalls.waitForChecks, [5], 'CI checked once for the existing PR');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [5],
    'PR merged after CI passes',
  );
});

test('resume: every task already done but no PR → recovers by opening a PR (not blocked)', async () => {
  // A prior run committed the task and crashed before opening the PR. The branch (reused on resume)
  // carries that commit, so the group recovers it into a PR instead of stranding it as blocked.
  const finished = group('finished', {
    branch: 'aitm/finished',
    tasks: [{ id: 'a', text: 'done', complexity: 'normal', done: true }],
  });
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { state, updates } = makeState([finished]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(finished);

  assert.equal(calls.runWorker.length, 0, 'no worker runs when every task is done');
  assert.equal(calls.openPr.length, 1, 'recovers the committed work into a PR');
  assert.equal(calls.openPr[0]?.delivery.branch, 'aitm/finished');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((g) => g.id === 'finished')?.status, 'awaiting-pr');
});

test('a fresh group whose only task is undone and not yet committed still blocks (nothing to recover)', async () => {
  // No task is `done`, so there is no recovered work — a genuine block must still block.
  const fresh = group('fresh', {
    tasks: [{ id: 'a', text: 'todo', complexity: 'normal', done: false }],
  });
  const { orchestrator, calls } = makeOrchestrator({
    workerResults: [{ kind: 'blocked', reason: 'no plan' }],
  });
  const { state, updates } = makeState([fresh]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(fresh);

  assert.equal(calls.openPr.length, 0, 'nothing committed → no PR');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((g) => g.id === 'fresh')?.status, 'blocked');
});

test('resume: an undone task blocks but a prior task was committed → recovers into a PR', async () => {
  // Task A was committed by a prior run (done), task B is undone and blocks this pass. The recovered
  // work (A's commit on the reused branch) opens a PR rather than being stranded as blocked.
  const resumed = group('multi', {
    branch: 'aitm/multi',
    tasks: [
      { id: 'a', text: 'first', complexity: 'normal', done: true },
      { id: 'b', text: 'second', complexity: 'complex', done: false },
    ],
  });
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    workerResults: [{ kind: 'blocked', reason: 'empty file manifest' }],
  });
  const { state, updates } = makeState([resumed]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(resumed);

  assert.equal(calls.runWorker.length, 1, 'only the undone task B is attempted');
  assert.equal(calls.openPr.length, 1, 'recovered work opens a PR, not blocked');
  assert.equal(calls.openPr[0]?.delivery.branch, 'aitm/multi');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((g) => g.id === 'multi')?.status, 'awaiting-pr');
});

test('recoveredDelivery: done tasks + no PR → delivery; else null', () => {
  const base = group('g', { branch: 'aitm/g' });
  // No done tasks → nothing to recover.
  assert.equal(recoveredDelivery(base), null);
  // A PR already exists → nothing to recover.
  assert.equal(
    recoveredDelivery({
      ...base,
      pr: 5,
      tasks: [{ id: 'a', text: 'first', complexity: 'normal', done: true }],
    }),
    null,
  );
  // Done task, no PR → a delivery anchored on the group branch + title.
  const d = recoveredDelivery({
    ...base,
    tasks: [{ id: 'a', text: 'first', complexity: 'normal', done: true }],
  });
  assert.ok(d);
  assert.equal(d.branch, 'aitm/g');
  assert.deepEqual(d.changes, []);
  assert.deepEqual(d.progressEntries, ['- first']);
});

test('alreadyCommittedDelivery: anchors on the group branch and the skipped task text', () => {
  const g = group('g', { branch: 'aitm/g' });
  const task: Task = { id: 'a', text: 'first', complexity: 'normal', done: false };
  const d = alreadyCommittedDelivery(g, task);
  assert.equal(d.branch, 'aitm/g');
  assert.equal(d.draftCommitMessage, 'first');
  assert.deepEqual(d.changes, []);
  assert.deepEqual(d.progressEntries, ['- first']);
});

test('alreadyCommittedDelivery: falls back to aitm/<id> when the group has no branch yet', () => {
  const g = group('g', { branch: null });
  const task: Task = { id: 'a', text: 'first', complexity: 'normal', done: false };
  assert.equal(alreadyCommittedDelivery(g, task).branch, 'aitm/g');
});

function twoTaskGroup(): PrGroup {
  return group('multi', {
    tasks: [
      { id: 'a', text: 'first task', complexity: 'normal', done: false },
      { id: 'b', text: 'second task', complexity: 'complex', done: false },
    ],
  });
}

test('group mode (default): a multi-task group opens exactly one PR after the final task', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { state } = makeState([twoTaskGroup()]);
  // prPerTask omitted → group-as-PR default.
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.runWorker.length, 2, 'one Worker pass per task');
  assert.equal(calls.openPr.length, 1, 'single group PR, opened after the last task');
});

// A Worker success result. The `ok` variant also carries a `handle` the WorkLoop never reads on this
// path, so — like makeOrchestrator's default stub — a cast keeps the fixture terse.
function okWorker(): WorkerResult {
  return { kind: 'ok', delivery: delivery() } as WorkerResult;
}

test('group mode: an earlier task commits then a later one blocks → partial PR merges, run is non-success', async () => {
  // Task A commits this pass; task B blocks this pass. workTasks ships A's work in the group PR (not
  // stranded), which merges under autoMerge — but B is left undone and is never rescheduled. The
  // group's terminal outcome must be `partial`, not `merged`, so the run does not exit 0 on the
  // silently dropped task.
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 42,
    workerResults: [okWorker(), { kind: 'blocked', reason: 'empty manifest' }],
  });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [] });
  const ready = makeGraph([twoTaskGroup()], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: true }),
  );
  const result = await loop.run();

  assert.equal(calls.runWorker.length, 2, 'both tasks attempted (A then B)');
  assert.equal(calls.openPr.length, 1, "A's committed work still ships a PR");
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [42],
    'the partial PR still merges — the landed work is not discarded',
  );

  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.status, 'partial', 'terminal outcome is partial, not merged');
  if (result.outcomes[0]?.status === 'partial') {
    assert.equal(result.outcomes[0].pr, 42);
    assert.deepEqual(result.outcomes[0].dropped, ['b'], 'the dropped task is named');
  }
  assert.equal(result.kind, 'blocked', 'a merged group with an undone task must not exit 0');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /partial/i);
    assert.match(result.reason, /\bb\b/, 'reason names the dropped task');
    assert.match(result.reason, /42/, 'reason names the shipped PR');
  }
});

test('group mode (no auto-merge): a partial PR opens but the run is non-success, not clean awaiting-pr', async () => {
  // Same partial group, autoMerge off: A's work opens a PR that stops at awaiting-pr. Without the
  // partial downgrade this would report a clean awaiting-pr (exit 0), hiding that B was dropped.
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 42,
    workerResults: [okWorker(), { kind: 'blocked', reason: 'empty manifest' }],
  });
  const { github, calls: ghCalls } = makeGithub();
  const ready = makeGraph([twoTaskGroup()], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: false }),
  );
  const result = await loop.run();

  assert.equal(calls.openPr.length, 1, "A's committed work still ships a PR");
  assert.deepEqual(ghCalls.mergePr, [], 'no merge under --no-automerge');
  assert.equal(result.outcomes[0]?.status, 'partial', 'partial, not a clean awaiting-pr');
  assert.equal(result.kind, 'blocked', 'non-success: task B was dropped');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /\bb\b/);
  }
});

test('group mode: resume recovers a committed task into a PR, but a still-blocked task makes it partial', async () => {
  // Task A committed in a prior run (done); B is undone and blocks this pass. The recovered PR ships
  // A's work (recoveredDelivery) rather than stranding it, but B stays dropped — so the run is
  // non-success (partial), not a clean merge that exits 0.
  const resumed = group('multi', {
    branch: 'aitm/multi',
    tasks: [
      { id: 'a', text: 'first', complexity: 'normal', done: true },
      { id: 'b', text: 'second', complexity: 'complex', done: false },
    ],
  });
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 9,
    workerResults: [{ kind: 'blocked', reason: 'empty file manifest' }],
  });
  const { github } = makeGithub({ checks: [ciSuccess], threads: [] });
  const ready = makeGraph([resumed], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: true }),
  );
  const result = await loop.run();

  assert.equal(calls.runWorker.length, 1, 'only the undone task B is attempted');
  assert.equal(calls.openPr.length, 1, "A's recovered work still ships a PR");
  assert.equal(result.outcomes[0]?.status, 'partial');
  if (result.outcomes[0]?.status === 'partial') {
    assert.deepEqual(result.outcomes[0].dropped, ['b']);
  }
  assert.equal(result.kind, 'blocked', 'B dropped → non-success');
});

test('mergeDeliveries: a single delivery is returned unchanged', () => {
  const d = delivery();
  assert.equal(mergeDeliveries([d]), d);
});

test('mergeDeliveries: unions changes (first-touch kind, latest summary), joins messages', () => {
  const a: WorkerDelivery = {
    branch: 'aitm/multi',
    draftCommitMessage: 'feat: a',
    changes: [{ path: 'a.ts', kind: 'create', summary: 'created a' }],
    progressEntries: ['- did a'],
  };
  const b: WorkerDelivery = {
    branch: 'aitm/multi',
    draftCommitMessage: 'feat: b',
    changes: [
      { path: 'b.ts', kind: 'create', summary: 'created b' },
      { path: 'a.ts', kind: 'modify', summary: 'extended a' },
    ],
    progressEntries: ['- did b'],
  };
  const merged = mergeDeliveries([a, b]);
  assert.equal(merged.branch, 'aitm/multi');
  assert.equal(merged.draftCommitMessage, 'feat: a\n\nfeat: b');
  assert.deepEqual(merged.progressEntries, ['- did a', '- did b']);
  assert.deepEqual(
    merged.changes.map((c) => c.path).sort(),
    ['a.ts', 'b.ts'],
    'every changed path appears once',
  );
  // a.ts is touched by both tasks: keep the first-touch kind (create), take the latest summary.
  assert.deepEqual(
    merged.changes.find((c) => c.path === 'a.ts'),
    { path: 'a.ts', kind: 'create', summary: 'extended a' },
  );
});

test("multi-task group: openPr receives a delivery merging every task's changes", async () => {
  const da: WorkerDelivery = {
    branch: 'aitm/multi',
    draftCommitMessage: 'feat: a',
    changes: [{ path: 'a.ts', kind: 'create', summary: 'created a' }],
    progressEntries: ['- a'],
  };
  const db: WorkerDelivery = {
    branch: 'aitm/multi',
    draftCommitMessage: 'feat: b',
    changes: [{ path: 'b.ts', kind: 'create', summary: 'created b' }],
    progressEntries: ['- b'],
  };
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    workerResults: [
      { kind: 'ok', delivery: da },
      { kind: 'ok', delivery: db },
    ],
  });
  const { state } = makeState([twoTaskGroup()]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.openPr.length, 1, 'single group PR');
  assert.deepEqual(
    calls.openPr[0]?.delivery.changes.map((c) => c.path).sort(),
    ['a.ts', 'b.ts'],
    "the PR delivery covers both tasks' changes, not just the last",
  );
});

test('multi-task group: a later task blocked after earlier commits → PR opens for the committed work', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    workerResults: [
      { kind: 'ok', delivery: delivery() },
      { kind: 'blocked', reason: 'empty file manifest' },
    ],
  });
  const { state, updates } = makeState([twoTaskGroup()]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.runWorker.length, 2, 'both tasks attempted');
  assert.equal(calls.finalizeCommit.length, 1, 'only the first task committed');
  assert.equal(calls.openPr.length, 1, 'PR opened for the committed work, not blocked');
  const last = updates[updates.length - 1] as RunState;
  const g = last.prGroups.find((p) => p.id === 'multi');
  assert.equal(g?.status, 'awaiting-pr', 'group surfaced as a PR, not stranded as blocked');
  assert.deepEqual(
    g?.tasks.map((t) => t.done),
    [true, false],
    'first task marked done, the blocked task left undone',
  );
});

test('prPerTask: opens a PR after every task (autoMerge off)', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { state } = makeState([twoTaskGroup()]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false, prPerTask: true }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.runWorker.length, 2);
  assert.equal(calls.openPr.length, 2, 'one PR per task under prPerTask');
});

test('prPerTask: each task PR runs CI then merges under autoMerge', async () => {
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [] });
  const loop = new WorkLoop(makeDeps({ orchestrator, github, autoMerge: true, prPerTask: true }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.openPr.length, 2, 'one PR per task');
  assert.equal(ghCalls.waitForChecks.length, 2, 'CI awaited per task PR');
  assert.equal(ghCalls.mergePr.length, 2, 'each task PR merged');
});

test('prPerTask: each completed task prints a "done in" timing line', async () => {
  const progress: string[] = [];
  const { orchestrator } = makeOrchestrator({ prNumber: 7 });
  const { github } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [] });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github,
      autoMerge: true,
      prPerTask: true,
      progress: (m) => progress.push(m),
      now: steppedClock(1000),
    }),
  );
  await loop.runGroup(twoTaskGroup());

  const taskLines = progress.filter((p) => /^group multi task \w+: done in \d+\.\ds$/.test(p));
  assert.equal(taskLines.length, 2, 'one timing line per task');
  const groupLine = progress.find((p) => /^group multi: merged — done in \d+\.\d[sm]$/.test(p));
  assert.ok(groupLine, "group total prints once, on the final task's merge");
});

test('prPerTask: resume skips done tasks and opens a PR only for the remaining one', async () => {
  const resumed = group('multi', {
    tasks: [
      { id: 'a', text: 'already done', complexity: 'normal', done: true },
      { id: 'b', text: 'still pending', complexity: 'normal', done: false },
    ],
  });
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 4 });
  const { state } = makeState([resumed]);
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false, prPerTask: true }));
  await loop.runGroup(resumed);

  assert.equal(calls.runWorker.length, 1, 'only the undone task runs');
  assert.equal(calls.runWorker[0]?.task?.id, 'b');
  assert.equal(calls.openPr.length, 1, 'one PR for the single remaining task');
});

test('prPerTask: multi-task group is marked merged only after the final task', async () => {
  // Regression: marking the whole group terminal after the FIRST task's PR strands the remaining
  // tasks — a crash there leaves a 'merged' group PlanGraph.ready() won't reschedule. The group
  // must stay schedulable (in-progress) until the last task lands.
  const { orchestrator } = makeOrchestrator({ prNumber: 7 });
  const { github } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [] });
  const { state, updates } = makeState([twoTaskGroup()]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(twoTaskGroup());

  const statusAt = (s: RunState): PrGroup['status'] | undefined =>
    s.prGroups.find((g) => g.id === 'multi')?.status;
  const mergedIdx = updates.findIndex((s) => statusAt(s) === 'merged');
  assert.equal(mergedIdx, updates.length - 1, 'group reaches merged only on the final write');
  assert.ok(
    !updates.slice(0, -1).some((s) => statusAt(s) === 'merged'),
    'group is never marked merged before the last task',
  );
});

test('prPerTask + autoMerge: each task branches off the merged base; its PR carries only its own changes', async () => {
  // The bug: every per-task PR opened from the SAME branch, so after task a squash-merged, task b's PR
  // re-included a's changes. Fix: each task resets to a fresh branch off origin/<base> (resetToBase),
  // then opens its PR from that branch — so b's PR carries b.ts only, and the reset for b happens after
  // a merges (proving b branches off a's merged result, not a's tip).
  const da: WorkerDelivery = {
    branch: 'unused',
    draftCommitMessage: 'feat: a',
    changes: [{ path: 'a.ts', kind: 'create', summary: 'created a' }],
    progressEntries: ['- a'],
  };
  const db: WorkerDelivery = {
    branch: 'unused',
    draftCommitMessage: 'feat: b',
    changes: [{ path: 'b.ts', kind: 'create', summary: 'created b' }],
    progressEntries: ['- b'],
  };
  const events: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    events,
    workerResults: [
      { kind: 'ok', delivery: da },
      { kind: 'ok', delivery: db },
    ],
  });
  const { github } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [], events });
  const { home, calls: homeCalls } = makeHome({ resetToBase: true, events });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, home, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(twoTaskGroup());

  // A fresh per-task branch off the base is created for each task, under the group branch.
  assert.deepEqual(homeCalls.resetToBase, [
    { groupId: 'multi', branch: 'aitm/multi-a', baseBranch: 'main' },
    { groupId: 'multi', branch: 'aitm/multi-b', baseBranch: 'main' },
  ]);
  // Each task's PR is opened from ITS OWN base-fresh branch.
  assert.deepEqual(
    calls.openPr.map((c) => c.group.branch),
    ['aitm/multi-a', 'aitm/multi-b'],
  );
  // The second task's PR carries only b.ts — it does NOT re-include the first task's a.ts.
  assert.deepEqual(
    calls.openPr[0]?.delivery.changes.map((c) => c.path),
    ['a.ts'],
  );
  assert.deepEqual(
    calls.openPr[1]?.delivery.changes.map((c) => c.path),
    ['b.ts'],
  );
  // Ordering: task b's base refresh happens AFTER task a's PR merges, so b branches off a's merged
  // result rather than a's branch tip.
  assert.deepEqual(events, [
    'reset:aitm/multi-a',
    'openPr:aitm/multi-a',
    'merge:7',
    'reset:aitm/multi-b',
    'openPr:aitm/multi-b',
    'merge:7',
  ]);
});

test('prPerTask + autoMerge fallback: a home without resetToBase keeps the single group branch', async () => {
  // A home that can't reset to base (e.g. a home that doesn't support it) falls back to the prior
  // single-branch behavior rather than failing — every task's PR opens off the one group branch.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github } = makeGithub({ checks: [ciSuccess, ciSuccess], threads: [] });
  const { home, calls: homeCalls } = makeHome(); // no resetToBase
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, home, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(twoTaskGroup());

  assert.deepEqual(homeCalls.resetToBase, [], 'no base refresh without the seam');
  assert.deepEqual(
    calls.openPr.map((c) => c.group.branch),
    ['aitm/multi', 'aitm/multi'],
    'both PRs open off the single group branch',
  );
});

test('prPerTask + --no-automerge: no base refresh; tasks stay on the single group branch', async () => {
  // Without autoMerge, tasks never merge mid-group, so there is no merged base to branch from — the
  // documented fallback keeps the single group branch even when the home CAN resetToBase.
  const events: string[] = [];
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { home, calls: homeCalls } = makeHome({ resetToBase: true, events });
  const loop = new WorkLoop(makeDeps({ orchestrator, home, autoMerge: false, prPerTask: true }));
  await loop.runGroup(twoTaskGroup());

  assert.equal(calls.openPr.length, 2, 'a PR per task');
  assert.deepEqual(homeCalls.resetToBase, [], 'no base refresh under --no-automerge');
  assert.deepEqual(
    calls.openPr.map((c) => c.group.branch),
    ['aitm/multi', 'aitm/multi'],
    'both PRs open off the single group branch',
  );
});

test('prPerTask + autoMerge: a red PR routes the fix through runCiFix (pushes), re-polls green, merges', async () => {
  // Regression: autoMergeFlow used to runWorker + finalizeCommit (git commit --amend) WITHOUT
  // pushing, so the recheck polled stale remote CI and the merge landed the unfixed remote. It now
  // routes through runCiFix — the shared fix session that rebases onto origin/<base> and
  // force-with-lease pushes — so the recheck re-polls against the pushed fix.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciFailure, ciSuccess], threads: [] });
  const loop = new WorkLoop(makeDeps({ orchestrator, github, autoMerge: true, prPerTask: true }));
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 1, 'the CI fix routes through the pushing fix session');
  assert.equal(calls.runCiFix[0]?.pr, 7);
  assert.equal(calls.runWorker.length, 1, 'the fix is not a second raw runWorker pass');
  assert.equal(
    calls.finalizeCommit.length,
    1,
    'the CI fix does not --amend (only the task commit)',
  );
  assert.deepEqual(ghCalls.waitForChecks, [7, 7], 'CI is re-polled after the fix is pushed');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [7],
    'PR merged once CI is green on the pushed fix',
  );
});

test('prPerTask + autoMerge: a CI fix that cannot land blocks the group without merging', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    ciFixResults: [{ kind: 'blocked', reason: 'still red after fix' }],
  });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciFailure], threads: [] });
  const { state, updates } = makeState([group('solo')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 1);
  assert.equal(ghCalls.waitForChecks.length, 1, 'no recheck once the fix fails to land');
  assert.equal(ghCalls.mergePr.length, 0, 'no merge when the fix cannot land');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'solo')?.status, 'blocked');
});

test('prPerTask + autoMerge: unresolved threads route through addressReviews (pushes) before merge', async () => {
  const thread: ReviewThread = {
    id: 't1',
    isResolved: false,
    path: 'a.ts',
    comments: [{ id: 'c1', body: 'nit', author: 'rev' }],
  };
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [thread] });
  const loop = new WorkLoop(makeDeps({ orchestrator, github, autoMerge: true, prPerTask: true }));
  await loop.runGroup(group('solo'));

  assert.equal(
    calls.addressReviews.length,
    1,
    'reviewer fixes go through the pushing addressReviews',
  );
  assert.deepEqual(
    calls.addressReviews[0]?.threads.map((t) => t.id),
    ['t1'],
  );
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [7],
    'PR merged after the reviewer fix is pushed',
  );
});

test('prPerTask + autoMerge: an unaddressable review thread blocks the group without merging', async () => {
  const thread: ReviewThread = {
    id: 't1',
    isResolved: false,
    path: 'a.ts',
    comments: [{ id: 'c1', body: 'nit', author: 'rev' }],
  };
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 7,
    addressReviewsResult: { kind: 'blocked', reason: 'reviewer error' },
  });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [thread] });
  const { state, updates } = makeState([group('solo')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.addressReviews.length, 1);
  assert.equal(ghCalls.mergePr.length, 0, 'no merge while the thread is unaddressed');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'solo')?.status, 'blocked');
});

test('prPerTask + autoMerge: a persistently red PR blocks after maxCiFixAttempts fixes, not one', async () => {
  // Regression: autoMergeFlow ran exactly one runCiFix + one recheck, ignoring maxCiFixAttempts. It
  // now loops the shared ciOutcomePolicy like driveStages — up to the cap — before blocking, so
  // prPerTask and the group-as-PR stage machine cap the recovery loop identically.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: Array(5).fill(ciFailure), threads: [] });
  const { state, updates } = makeState([group('solo')]);
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github,
      state,
      autoMerge: true,
      prPerTask: true,
      maxCiFixAttempts: 2,
    }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 2, 'the fix loops up to the cap, not exactly once');
  assert.equal(ghCalls.waitForChecks.length, 3, 'CI polled once before each fix, cap + 1 times');
  assert.equal(ghCalls.mergePr.length, 0, 'a still-red PR is never merged');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'solo')?.status, 'blocked');
});

test('prPerTask + autoMerge: a red PR that goes green on the last allowed fix merges (cap boundary)', async () => {
  // The cap allows N fixes, not N − 1: with maxCiFixAttempts 2 a PR that recovers on the 2nd fix
  // must merge, not strand. Guards the same off-by-one the stage machine's cap-boundary test guards.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({
    checks: [ciFailure, ciFailure, ciSuccess],
    threads: [],
  });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, autoMerge: true, prPerTask: true, maxCiFixAttempts: 2 }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 2, 'both allowed fixes run');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [7],
    'the recovered PR merges on the last allowed attempt',
  );
});

test('prPerTask + autoMerge: a CI poll timeout blocks the group (no --admin)', async () => {
  // A waitForChecks CiFailed (checks never settled) blocks rather than merging a PR whose CI never
  // completed — and, unlike the old one-shot flow, without spending a fix pass on a timeout.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 9 });
  const { github, calls: ghCalls } = makeGithub({
    checks: [new CiFailed('checks did not settle')],
    threads: [],
  });
  const { state, updates } = makeState([group('solo')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prPerTask: true }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(calls.runCiFix.length, 0, 'a timeout blocks — no fix pass runs');
  assert.equal(ghCalls.mergePr.length, 0, 'a PR whose CI never settled is never merged');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'solo')?.status, 'blocked');
});

test('prPerTask + autoMerge + --admin: a CI poll timeout skips past CI to review, then merges', async () => {
  // The --admin CI-timeout override, previously honored only by the stage machine: a timeout
  // force-advances past CI to reviews instead of blocking. Shared via ciOutcomePolicy.
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 9 });
  const { github, calls: ghCalls } = makeGithub({
    checks: [new CiFailed('checks did not settle')],
    threads: [],
  });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github,
      autoMerge: true,
      prPerTask: true,
      adminMerge: true,
    }),
  );
  await loop.runGroup(group('solo'));

  assert.equal(ghCalls.waitForChecks.length, 1, 'the timeout is not re-polled — it advances');
  assert.equal(calls.runCiFix.length, 0, 'a timeout advances past CI, it does not run a fix');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [9],
    '--admin force-advances the timeout to review and merges',
  );
});

test('autoMerge: success path runs waitForChecks → mergePr and marks merged', async () => {
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 11 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [] });
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
  assert.equal(orchCalls.addressReviews.length, 0, 'reviewer not invoked when no threads');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'gamma')?.status, 'merged');
});

test('group mode (default): merging prints a group total "done in" timing line', async () => {
  const progress: string[] = [];
  const { orchestrator } = makeOrchestrator({ prNumber: 11 });
  const { github } = makeGithub({ checks: [ciSuccess], threads: [] });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github,
      autoMerge: true,
      progress: (m) => progress.push(m),
      now: steppedClock(1000),
    }),
  );
  await loop.runGroup(group('gamma'));

  assert.ok(
    progress.some((p) => /^group gamma: ready-to-merge → merged — done in \d+\.\d[sm]$/.test(p)),
    'the ready-to-merge → merged transition line carries the group total',
  );
});

test('autoMerge: a thread already carrying our reply is skipped → merges without re-running the Reviewer', async () => {
  // Wiring for the self-healing bot-reply skip (freshThreads via authenticatedLogin): the reply
  // landed on GitHub on a prior pass but its addressed record was lost. On resume the loop must
  // recognize our own reply and converge to merge, not re-feed the thread to the Reviewer. prContext
  // is present only to guarantee termination if the skip ever regresses — with it working,
  // addressReviews is never called.
  const repliedThread: ReviewThread = {
    id: 't1',
    isResolved: false,
    path: 'a.ts',
    comments: [
      { id: 'c1', body: 'nit', author: 'coderabbit' },
      { id: 'c2', body: 'fixed', author: 'aitm-bot' },
    ],
  };
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 11 });
  const { github, calls: ghCalls } = makeGithub({
    checks: [ciSuccess],
    threads: [repliedThread],
    botLogin: 'aitm-bot',
  });
  const { state, updates } = makeState([group('gamma')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prContext: makeAddressedStore() }),
  );
  await loop.runGroup(group('gamma'));

  assert.equal(
    orchCalls.addressReviews.length,
    0,
    'the already-replied thread never reaches the Reviewer',
  );
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [11],
    'PR merged once, no re-address loop',
  );
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'gamma')?.status, 'merged');
});

test('autoMerge: CI failure → ci-failed runs the fix session, re-polls green, merges', async () => {
  // waiting-ci sees a red run → ci-failed delegates to runCiFix (shared fix session) → waiting-ci
  // re-polls green → merge. Mirrors claudetm's handle_ci_failed_stage → waiting_ci loop.
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 33 });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciFailure, ciSuccess], threads: [] });
  const { state, updates } = makeState([group('delta')]);
  const loop = new WorkLoop(makeDeps({ orchestrator, github, state, autoMerge: true }));
  await loop.runGroup(group('delta'));

  assert.equal(orchCalls.runCiFix.length, 1, 'fix session runs once on the red PR');
  assert.equal(orchCalls.runCiFix[0]?.pr, 33);
  assert.deepEqual(ghCalls.waitForChecks, [33, 33], 'CI polled before and after the fix');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [33],
    'PR merged after CI goes green',
  );
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'delta')?.status, 'merged');
});

test('autoMerge: a CI fix that cannot land blocks the group', async () => {
  const { orchestrator, calls: orchCalls } = makeOrchestrator({
    prNumber: 33,
    ciFixResults: [{ kind: 'blocked', reason: 'rebase conflict' }],
  });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciFailure] });
  const { state, updates } = makeState([group('delta')]);
  const loop = new WorkLoop(makeDeps({ orchestrator, github, state, autoMerge: true }));
  await loop.runGroup(group('delta'));

  assert.equal(orchCalls.runCiFix.length, 1);
  assert.equal(ghCalls.mergePr.length, 0, 'no merge when the fix could not land');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'delta')?.status, 'blocked');
});

// A red PR whose fix session keeps "succeeding" (pushes a commit) but never turns CI green would
// cycle waiting-ci ⇄ ci-failed forever. The cap bounds that recovery loop (issue #128).
function redCiGroup(id: string, pr: number): PrGroup {
  return {
    ...group(id, { stage: 'waiting-ci', pr, status: 'awaiting-pr' }),
    tasks: [{ id: 't1', text: 't', complexity: 'normal', done: true }],
  };
}

test('CI-fix cap: an unfixable red PR blocks after exactly maxCiFixAttempts fix passes (issue #128)', async () => {
  // fixCi always reports 'ok' (a commit landed) but CI stays red, so waiting-ci re-routes to
  // ci-failed each pass. With the cap at 2, the 3rd ci-failed entry blocks WITHOUT a 3rd fixCi.
  const g = redCiGroup('cap', 7);
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 7 });
  const { github, calls: ghCalls } = makeGithub({ checks: Array(5).fill(ciFailure), threads: [] });
  const ready = makeGraph([g], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: true, maxCiFixAttempts: 2 }),
  );
  const result = await loop.run();

  assert.equal(orchCalls.runCiFix.length, 2, 'fixCi runs exactly maxCiFixAttempts times');
  assert.equal(
    ghCalls.waitForChecks.length,
    3,
    'CI polled once before each ci-failed, cap + 1 times',
  );
  assert.equal(ghCalls.mergePr.length, 0, 'a still-red PR is never merged');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /CI fix attempts exhausted after 2 passes/);
    assert.match(result.reason, /#7/);
  }
});

test('CI-fix cap: a CiFailed poll timeout blocks without a fix pass (issue #128, block-on-timeout)', async () => {
  // A waitForChecks CiFailed (checks never settled within CHECKS_TIMEOUT_MS) no longer routes to the
  // fix loop — it blocks the group directly (block-not-merge on timeout, feat 62f0b7a), so a
  // perpetually-timing-out PR never loops and never runs a fix pass. A real red *status* still routes
  // to ci-failed (covered above). `--admin` force-advances the timeout to reviews (stage-handlers.test).
  const g = redCiGroup('cap-timeout', 9);
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 9 });
  const { github } = makeGithub({
    checks: Array(5)
      .fill(null)
      .map(() => new CiFailed('checks did not settle')),
    threads: [],
  });
  const ready = makeGraph([g], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: true, maxCiFixAttempts: 2 }),
  );
  const result = await loop.run();

  assert.equal(orchCalls.runCiFix.length, 0, 'a CiFailed timeout blocks — no fix pass runs');
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /blocked at stage 'waiting-ci'/);
  }
});

test('CI-fix cap: defaults to DEFAULT_MAX_CI_FIX_ATTEMPTS when unset', async () => {
  const g = redCiGroup('cap-default', 11);
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 11 });
  const { github } = makeGithub({ checks: Array(8).fill(ciFailure), threads: [] });
  const ready = makeGraph([g], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: true }),
  );
  const result = await loop.run();

  assert.equal(
    orchCalls.runCiFix.length,
    DEFAULT_MAX_CI_FIX_ATTEMPTS,
    'without an override the default cap governs',
  );
  assert.equal(result.kind, 'blocked');
});

test('CI-fix cap: a fix that lands green on the last allowed attempt merges, does not block (issue #128)', async () => {
  // Boundary: with the cap at 2 a PR that goes green on the 2nd fix must merge — the cap allows N
  // fixes, not N − 1. Guards against an off-by-one that would strand a recoverable PR.
  const g = redCiGroup('cap-boundary', 13);
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 13 });
  const { github, calls: ghCalls } = makeGithub({
    checks: [ciFailure, ciFailure, ciSuccess],
    threads: [],
  });
  const ready = makeGraph([g], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: true, maxCiFixAttempts: 2 }),
  );
  const result = await loop.run();

  assert.equal(orchCalls.runCiFix.length, 2, 'both allowed fixes run');
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [13],
    'the recovered PR merges on the last allowed attempt',
  );
  assert.equal(result.kind, 'success');
});

test('CI-fix cap: the durable count survives resume — an at-cap group blocks with no further fix (issue #128)', async () => {
  // The count is persisted on the group, so a resumed group re-enters carrying its spent budget. One
  // already at the cap immediately exceeds it and parks for a human WITHOUT another fix pass — the old
  // in-memory counter reset to zero and re-burned the whole budget every resume.
  const g = { ...redCiGroup('cap-resume', 15), ciFixAttempts: 2 };
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 15 });
  const { github } = makeGithub({ checks: Array(4).fill(ciFailure), threads: [] });
  const { state, updates } = makeState([g]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, maxCiFixAttempts: 2 }),
  );
  await loop.runGroup(g);

  assert.equal(
    orchCalls.runCiFix.length,
    0,
    'the exhausted budget survives resume — no further fix runs',
  );
  const persisted = (updates[updates.length - 1] as RunState).prGroups.find(
    (p) => p.id === 'cap-resume',
  );
  assert.equal(persisted?.status, 'blocked');
  assert.equal(
    persisted?.humanNeeded,
    true,
    'flagged human-needed so a resume never resurrects it',
  );
});

test('CI-fix cap: a resumed group continues counting from its persisted attempts, not from zero (issue #128)', async () => {
  // One pass was spent before the interrupt (ciFixAttempts: 1). With the cap at 3 the resume runs
  // only the two REMAINING passes, then blocks — total fix work across runs stays bounded by the cap.
  const g = { ...redCiGroup('cap-continue', 17), ciFixAttempts: 1 };
  const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 17 });
  const { github } = makeGithub({ checks: Array(6).fill(ciFailure), threads: [] });
  const { state, updates } = makeState([g]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, maxCiFixAttempts: 3 }),
  );
  await loop.runGroup(g);

  assert.equal(
    orchCalls.runCiFix.length,
    2,
    'resume runs only the remaining budget (cap 3 − 1 already spent)',
  );
  const persisted = (updates[updates.length - 1] as RunState).prGroups.find(
    (p) => p.id === 'cap-continue',
  );
  assert.equal(persisted?.ciFixAttempts, 4, 'the durable counter advances to the blocking entry');
  assert.equal(persisted?.humanNeeded, true);
});

test('autoMerge: unresolved threads → addressing-reviews runs the Reviewer, then merges', async () => {
  // waiting-reviews sees a fresh unresolved thread → addressing-reviews runs the Reviewer over it
  // and records it addressed → waiting-reviews sees nothing fresh → ready-to-merge → merge.
  const thread: ReviewThread = {
    id: 't1',
    isResolved: false,
    path: 'a.ts',
    comments: [{ id: 'c1', body: 'nit', author: 'rev' }],
  };
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 5 });
  const { github, calls: ghCalls } = makeGithub({ threads: [thread] });
  const { state, updates } = makeState([group('epsilon')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prContext: makeAddressedStore() }),
  );
  await loop.runGroup(group('epsilon'));

  assert.equal(calls.addressReviews.length, 1, 'reviewer driven once over the fresh thread');
  assert.deepEqual(
    calls.addressReviews[0]?.threads.map((t) => t.id),
    ['t1'],
  );
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [5],
    'PR merged after the thread is addressed',
  );
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'epsilon')?.status, 'merged');
});

test('autoMerge: an unaddressable review thread blocks the group', async () => {
  const thread: ReviewThread = {
    id: 't1',
    isResolved: false,
    path: 'a.ts',
    comments: [{ id: 'c1', body: 'nit', author: 'rev' }],
  };
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 5,
    addressReviewsResult: { kind: 'blocked', reason: 'reviewer error' },
  });
  const { github, calls: ghCalls } = makeGithub({ threads: [thread] });
  const { state, updates } = makeState([group('epsilon')]);
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, state, autoMerge: true, prContext: makeAddressedStore() }),
  );
  await loop.runGroup(group('epsilon'));

  assert.equal(calls.addressReviews.length, 1);
  assert.equal(ghCalls.mergePr.length, 0, 'no merge while the thread is unaddressed');
  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'epsilon')?.status, 'blocked');
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

test('runGroup: a dirty working tree aborts the run instead of blocking the group', async () => {
  const { state, updates } = makeState([group('theta')]);
  const releases: string[] = [];
  const home: CheckoutHome = {
    acquire: () => Promise.reject(new DirtyWorkingTree('/repo', [' M src/a.ts'])),
    release: async (groupId) => {
      releases.push(groupId);
    },
  };
  const loop = new WorkLoop(makeDeps({ state, home }));

  await assert.rejects(() => loop.runGroup(group('theta')), DirtyWorkingTree);

  const last = updates[updates.length - 1] as RunState;
  assert.equal(
    last.prGroups.find((p) => p.id === 'theta')?.status,
    'in-progress',
    'the precondition failure must not rewrite the group as blocked',
  );
  assert.deepEqual(releases, [], 'a slot never taken is never released');
});

// composePr (orchestrator.ts) is total: schema-invalid or section-incomplete compositions are
// retried in-conversation and, failing that, replaced by a deterministic fallback — never thrown.
// So openPr (the WorkLoopOrchestrator port WorkLoop actually calls) never rejects for a
// composition-shaped reason; only a genuine external failure (push/gh) reaches runGroup's catch.
test('openPr resolving (composition issues absorbed by composePr fallback) never blocks the group', async () => {
  const { state, updates } = makeState([group('mu')]);
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async () => ({ kind: 'ok', delivery: delivery() }),
    finalizeCommit: async () => 'sha',
    // Stands in for composePr's fallback path: whatever went wrong composing the title/body,
    // openPr is total and still resolves with a valid PR.
    openPr: async () => pullRequest(42),
    runCiFix: async () => ({ kind: 'ok' }),
    addressReviews: async () => ({ kind: 'ok' }),
  };
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(group('mu'));

  const last = updates[updates.length - 1] as RunState;
  assert.notEqual(last.prGroups.find((p) => p.id === 'mu')?.status, 'blocked');
  assert.equal(last.prGroups.find((p) => p.id === 'mu')?.status, 'awaiting-pr');
});

test('openPr rejecting with a genuine push/gh failure still blocks the group', async () => {
  const { state, updates } = makeState([group('nu')]);
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async () => ({ kind: 'ok', delivery: delivery() }),
    finalizeCommit: async () => 'sha',
    openPr: async () => {
      throw new Error('failed to push branch aitm/nu: remote rejected');
    },
    runCiFix: async () => ({ kind: 'ok' }),
    addressReviews: async () => ({ kind: 'ok' }),
  };
  const loop = new WorkLoop(makeDeps({ orchestrator, state, autoMerge: false }));
  await loop.runGroup(group('nu'));

  const last = updates[updates.length - 1] as RunState;
  assert.equal(last.prGroups.find((p) => p.id === 'nu')?.status, 'blocked');
});

test('home.release fires even when orchestrator throws', async () => {
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async () => {
      throw new Error('worker exploded');
    },
    finalizeCommit: async () => 'sha',
    openPr: async () => pullRequest(1),
    runCiFix: async () => ({ kind: 'ok' }),
    addressReviews: async () => ({ kind: 'ok' }),
  };
  const { home, calls } = makeHome();
  const loop = new WorkLoop(makeDeps({ orchestrator, home }));
  await loop.runGroup(group('iota'));
  assert.deepEqual(calls.release, ['iota']);
});

test('a catch-path block emits a progress line carrying the reason (not a silent block)', async () => {
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async () => {
      throw new Error('provider exploded');
    },
    finalizeCommit: async () => 'sha',
    openPr: async () => pullRequest(1),
    runCiFix: async () => ({ kind: 'ok' }),
    addressReviews: async () => ({ kind: 'ok' }),
  };
  const progress: string[] = [];
  const loop = new WorkLoop(makeDeps({ orchestrator, progress: (m) => progress.push(m) }));
  await loop.runGroup(group('kappa'));
  assert.ok(
    progress.some((m) => /group kappa: → blocked \(provider exploded\)/.test(m)),
    `expected a blocked progress line with the reason, got: ${JSON.stringify(progress)}`,
  );
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
  const { home, calls: homeCalls } = makeHome();
  const loop = new WorkLoop(
    makeDeps({ orchestrator, graph, home, concurrency: 2, autoMerge: true }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'success');
  assert.equal(calls.runWorker.length, 3, 'all three groups processed');
  // Home tracks live size at the moment of acquire — in the 2-concurrent pass the
  // second acquire observes the first as still live (size 1), proving they overlapped.
  assert.ok(
    homeCalls.activeAtAcquire.slice(0, 2).some((n) => n === 1),
    `expected at least one overlap in first batch, got ${homeCalls.activeAtAcquire.join(',')}`,
  );
  // Third acquire fires after both first-batch releases, so live=0 at that moment.
  assert.equal(homeCalls.activeAtAcquire[2], 0);
});

test('runGroup serializes the worker edit/commit across a concurrent batch, yet still dispatches concurrently (checkout mutex, DECISION 1)', async () => {
  // Two groups ready at once, concurrency 2: the driver dispatches both (acquire overlaps), but the
  // shared single checkout holds one branch at a time, so the git-mutating worker edit/commit must
  // run for one group at a time. The mutex guarantees no overlap regardless of timing.
  const groups = [group('g1'), group('g2')];
  let pass = 0;
  const graph: WorkLoopGraph = {
    ready: () => (pass++ === 0 ? groups.slice() : []),
    isComplete: () => pass >= 1,
  };
  const { orchestrator: base, calls } = makeOrchestrator();
  let inFlight = 0;
  let maxInFlight = 0;
  const orchestrator: WorkLoopOrchestrator = {
    ...base,
    runWorker: async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield a macrotask so a second, unserialized worker would be observed overlapping here.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      const result = await base.runWorker(input);
      inFlight -= 1;
      return result;
    },
  };
  const { home, calls: homeCalls } = makeHome();
  const loop = new WorkLoop(
    makeDeps({ orchestrator, graph, home, concurrency: 2, autoMerge: false }),
  );
  const result = await loop.run();

  assert.equal(result.kind, 'awaiting-pr');
  assert.equal(calls.runWorker.length, 2, 'both groups ran the worker');
  assert.equal(maxInFlight, 1, 'the checkout mutex serialized the worker edit/commit — no overlap');
  assert.ok(
    homeCalls.activeAtAcquire.some((n) => n === 1),
    `the batch still dispatched concurrently (acquire overlapped), got ${homeCalls.activeAtAcquire.join(',')}`,
  );
});

// Resolves to whether `p` has settled yet WITHOUT awaiting a pending promise to completion: a marker
// that resolves next microtask races the promise's own continuation. If `p` already settled, its
// continuation is queued first and wins; if `p` is still pending, only the marker resolves.
async function settledState(p: Promise<unknown>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  const marker = Symbol('pending');
  const outcome = await Promise.race([
    p.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    Promise.resolve(marker),
  ]);
  return outcome === marker ? 'pending' : outcome;
}

test('run(): a session-count write failure waits for in-flight siblings before propagating (allSettled, not Promise.all)', async () => {
  // Two groups dispatched at concurrency 2. g1's session-count write fails; g2's succeeds and its
  // runGroup is mid-flight (worker parked on a gate). The failure must NOT surface until g2 settles —
  // Promise.all would reject the moment g1's increment throws, while g2's Git/PR side effects run on.
  const groups = [group('g1'), group('g2')];
  let pass = 0;
  const graph: WorkLoopGraph = {
    ready: () => (pass++ === 0 ? groups.slice() : []),
    isComplete: () => pass >= 1,
  };

  // Callbacks run in batch order and increment BEFORE runGroup, so the first state.update is g1's
  // session-count bump — reject it; every later write (g2's bump, both groups' status writes) passes.
  let updateCalls = 0;
  let current: RunState = { ...baseState(), prGroups: groups };
  const state: WorkLoopState = {
    update: async (mutator) => {
      updateCalls += 1;
      if (updateCalls === 1) throw new Error('counter write failed');
      current = mutator(current);
      return current;
    },
  };

  // g2's worker parks on a gate the test controls; `atGate` fires the instant it parks, so the run
  // can be observed while g2 is provably still in flight.
  let openGate = (): void => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let reachedGate = (): void => {};
  const atGate = new Promise<void>((resolve) => {
    reachedGate = resolve;
  });
  const { orchestrator: base, calls } = makeOrchestrator();
  const orchestrator: WorkLoopOrchestrator = {
    ...base,
    runWorker: async (input) => {
      reachedGate();
      await gate;
      return base.runWorker(input);
    },
  };
  const { home, calls: homeCalls } = makeHome();

  const loop = new WorkLoop(
    makeDeps({ orchestrator, graph, home, state, concurrency: 2, autoMerge: false }),
  );

  const run = loop.run();
  await atGate;
  // Drain any queued continuations so that, under the old Promise.all, g1's rejection has fully
  // propagated into run() by now — making the pending assertion below a true fix-vs-bug discriminator.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(
    await settledState(run),
    'pending',
    'run() must stay pending while g2 is still in flight — Promise.all would already have rejected',
  );

  openGate();
  await assert.rejects(run, /counter write failed/);
  assert.ok(
    calls.runWorker.some((c) => c.group.id === 'g2'),
    'g2 ran its worker to completion before the failure surfaced',
  );
  assert.deepEqual(
    homeCalls.release.filter((id) => id === 'g2'),
    ['g2'],
    'g2 released its checkout (its runGroup fully settled) before run() rejected',
  );
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

test('run(): an already-aborted signal → cancelled before any group runs', async () => {
  const controller = new AbortController();
  controller.abort();
  const ready = makeGraph([group('a')], { completeAfter: 5 });
  const { orchestrator, calls } = makeOrchestrator();
  const loop = new WorkLoop(
    makeDeps({ orchestrator, graph: ready.graph, signal: controller.signal }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'cancelled');
  assert.equal(calls.runWorker.length, 0, 'no worker invoked once the signal is already aborted');
});

test("run(): the run's signal reaches the Worker invocation", async () => {
  // The mid-batch cancel above only holds because the signal actually reaches the in-flight LLM
  // calls; the port field is what carries it (WorkerInvocation.signal → WorkerInput.signal). Left
  // unpassed, an abort would be noticed only between groups, after a full pass burned its tokens.
  const controller = new AbortController();
  const ready = makeGraph([group('a')], { completeAfter: 1 });
  const { orchestrator, calls } = makeOrchestrator();
  const loop = new WorkLoop(
    makeDeps({ orchestrator, graph: ready.graph, signal: controller.signal }),
  );
  await loop.run();
  assert.equal(calls.runWorker.length, 1);
  assert.equal(calls.runWorker[0]?.signal, controller.signal);
});

test('run(): no run signal → the Worker invocation omits it', async () => {
  const ready = makeGraph([group('a')], { completeAfter: 1 });
  const { orchestrator, calls } = makeOrchestrator();
  const loop = new WorkLoop(makeDeps({ orchestrator, graph: ready.graph }));
  await loop.run();
  assert.equal(calls.runWorker.length, 1);
  assert.ok(
    calls.runWorker[0] && !('signal' in calls.runWorker[0]),
    'exactOptionalPropertyTypes: an absent signal is omitted, never passed as undefined',
  );
});

test('run(): signal aborts mid-batch → cancelled, not blocked, even though the abort failed the group', async () => {
  // Mirrors a real SIGINT: an in-flight worker call rejects with an AbortError (worker.ts signal
  // wiring) at the same instant the run's own AbortController flips. Without the post-batch
  // signal check, runGroup's catch would report this group `blocked` and the run would exit 1
  // instead of the cancelled exit 2 a user-initiated Ctrl-C promises.
  const controller = new AbortController();
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async () => {
      controller.abort();
      throw new Error('The operation was aborted');
    },
    finalizeCommit: async () => {
      throw new Error('finalizeCommit must not run');
    },
    openPr: async () => {
      throw new Error('openPr must not run');
    },
    runCiFix: async () => {
      throw new Error('runCiFix must not run');
    },
    addressReviews: async () => {
      throw new Error('addressReviews must not run');
    },
  };
  const ready = makeGraph([group('a')], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, graph: ready.graph, signal: controller.signal }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'cancelled');
});

test("driveStages: the run's signal reaches the stage CI poll, and a cancelled poll never merges", async () => {
  // A cancelled GitHubClient.waitForChecks returns the non-verdict 'pending'. The stage machine
  // must stay in waiting-ci and the dispatcher must end the group there — not read 'pending' as a
  // CI failure (an LLM fix pass) and not walk on to the merge.
  const controller = new AbortController();
  const { github, calls: ghCalls } = makeGithub();
  const seen: Array<AbortSignal | undefined> = [];
  const cancelling: WorkLoopGithub = {
    ...github,
    waitForChecks: async (_pr, signal) => {
      seen.push(signal);
      controller.abort();
      return { state: 'pending', failedChecks: [] };
    },
  };
  const { orchestrator, calls } = makeOrchestrator({ prNumber: 7 });
  const ready = makeGraph([group('a')], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github: cancelling,
      graph: ready.graph,
      signal: controller.signal,
      autoMerge: true,
    }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'cancelled');
  assert.equal(seen[0], controller.signal, 'StageDeps.signal reaches waitForChecks');
  assert.deepEqual(ghCalls.mergePr, [], 'a cancelled run never merges');
  assert.deepEqual(calls.runCiFix, [], "'pending' from a cancelled poll is not a CI failure");
});

test('driveStages: abort after CI settles → stops before ready-to-merge', async () => {
  // The abort lands while the review threads are being read, i.e. the stage handler still returns
  // 'ready-to-merge'. The dispatcher's pre-handler check is what keeps `gh pr merge` from running.
  const controller = new AbortController();
  const { github, calls: ghCalls } = makeGithub();
  const cancelling: WorkLoopGithub = {
    ...github,
    listUnresolvedThreads: async () => {
      controller.abort();
      return [];
    },
  };
  const { orchestrator } = makeOrchestrator({ prNumber: 7 });
  const ready = makeGraph([group('a')], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github: cancelling,
      graph: ready.graph,
      signal: controller.signal,
      autoMerge: true,
    }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'cancelled');
  assert.deepEqual(ghCalls.mergePr, [], 'the merge stage is never dispatched on a cancelled run');
});

test('prPerTask autoMerge: abort during the CI wait → the task PR is not merged', async () => {
  // The prPerTask flow has no stage machine to stop it: without its own post-wait check, a
  // cancelled 'pending' wait reads as "not failing" and falls straight through to the merge.
  const controller = new AbortController();
  const { github, calls: ghCalls } = makeGithub();
  const cancelling: WorkLoopGithub = {
    ...github,
    waitForChecks: async () => {
      controller.abort();
      return { state: 'pending', failedChecks: [] };
    },
  };
  const { orchestrator } = makeOrchestrator({ prNumber: 7 });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator,
      github: cancelling,
      autoMerge: true,
      prPerTask: true,
      signal: controller.signal,
    }),
  );
  await loop.runGroup(group('a'));
  assert.deepEqual(ghCalls.mergePr, [], 'a cancelled run never merges');
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
  // Update calls in this path: in-progress, task-done, awaiting-pr — none should touch sessionCount.
  for (const s of updates) {
    assert.equal(s.sessionCount, 0, 'markStatus must not bump sessionCount');
  }
});

test('run() bumps persisted sessionCount once per started group, not once by batch.length', async () => {
  // A batch of 3 groups charges one session AS EACH GROUP STARTS — three separate +1 writes whose
  // distinct persisted values climb 1 → 2 → 3 — rather than a single upfront +3. A crash mid-batch
  // then persists only the groups that actually started, so a resume never inherits an inflated
  // count that trips the session cap before the still-unrun groups get their turn.
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

  const distinctCounts = updates.map((s) => s.sessionCount).filter((c, i, all) => c !== all[i - 1]);
  assert.deepEqual(distinctCounts, [1, 2, 3], 'sessionCount climbs one per started group');
  const last = updates[updates.length - 1];
  assert.equal(last?.sessionCount, 3, 'final persisted sessionCount equals groups started');
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
      // Stage-dispatcher write order: 1 incrementSessionCount, 2 in-progress(+working),
      // 3 task-done, 4 stage working→pr-open, 5 handlePrOpen's pr-persist after openPr (fail here).
      if (callCount === 5) throw new Error('disk full');
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

test('autoMerge: state write failure after openPr → dangling PR is non-success, not exit-0 success', async () => {
  // The autoMerge counterpart of the test above. Same StateWriteAfterSuccess (openPr landed, the
  // pr-persist failed), but under autoMerge the group never reached 'merged'. The recovered outcome
  // stays awaiting-pr so a retry doesn't reopen the PR — yet the RUN must NOT report 'success', which
  // would exit 0 with a dangling unmerged PR. finalResult surfaces it as blocked (non-success).
  const { orchestrator } = makeOrchestrator({ prNumber: 77 });
  let callCount = 0;
  const state: WorkLoopState = {
    update: async (mutator) => {
      callCount++;
      // Writes 1–5 are autoMerge-independent (autoMerge only affects the writes AFTER pr-open):
      // 1 sessionCount, 2 in-progress(+working), 3 task-done, 4 working→pr-open, 5 pr-persist (fail).
      if (callCount === 5) throw new Error('disk full');
      return mutator(baseState());
    },
  };
  const ready = makeGraph([group('nu')], { completeAfter: 1 });
  const loop = new WorkLoop(makeDeps({ orchestrator, state, graph: ready.graph, autoMerge: true }));
  const result = await loop.run();

  // The external side effect is preserved so a retry never reopens the PR…
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.status, 'awaiting-pr');
  if (result.outcomes[0]?.status === 'awaiting-pr') {
    assert.equal(result.outcomes[0].pr, 77);
  }
  // …but the run itself is non-success: a dangling unmerged PR under autoMerge must not exit 0.
  assert.equal(
    result.kind,
    'blocked',
    'awaiting-pr under autoMerge must be non-success, not reported as merged',
  );
  if (result.kind === 'blocked') {
    assert.match(result.reason, /77/, 'the reason names the dangling PR');
    assert.match(result.reason, /not merged/i);
  }
});

test('run(): CI fix rebase conflict → WorkLoopResult.kind === "blocked" with conflict reason', async () => {
  // Conflict scenario propagated through run(): ciFixResult blocked → group blocked → run blocked.
  const { orchestrator } = makeOrchestrator({
    prNumber: 55,
    ciFixResults: [{ kind: 'blocked', reason: 'rebase conflict needs manual resolution' }],
  });
  const { github } = makeGithub({ checks: [ciFailure] });
  const ready = makeGraph([group('conflict')], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: true }),
  );
  const result = await loop.run();
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /conflict/i, 'reason contains conflict');
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0]?.status, 'blocked');
  }
});

test('run(): session cap reached → WorkLoopResult.kind === "session-cap"', async () => {
  // Explicit assertion that the cap result is preserved through run() and carries no blocked outcome.
  const groups = [group('a'), group('b'), group('c')];
  let pass = 0;
  const graph: WorkLoopGraph = {
    ready: () => {
      pass++;
      return groups.slice(pass - 1);
    },
    isComplete: () => pass > 10,
  };
  const { orchestrator } = makeOrchestrator();
  const loop = new WorkLoop(makeDeps({ orchestrator, graph, concurrency: 3, maxSessions: 1 }));
  const result = await loop.run();
  assert.equal(result.kind, 'session-cap');
  // Outcomes record whatever groups ran before the cap fired.
  assert.ok(Array.isArray(result.outcomes));
});

test('state write failure after mergePr → outcome stays merged', async () => {
  const { orchestrator } = makeOrchestrator({ prNumber: 88 });
  let callCount = 0;
  const state: WorkLoopState = {
    update: async (mutator) => {
      callCount++;
      // Stage-dispatcher write order: 1 sessionCount, 2 in-progress(+working), 3 task-done,
      // 4 working→pr-open, 5 pr-persist, 6 pr-open→waiting-ci, 7 waiting-ci→waiting-reviews,
      // 8 waiting-reviews→ready-to-merge, 9 ready-to-merge→merged after mergePr (fail here).
      if (callCount === 9) throw new Error('disk full');
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

test('ciFixFailedError: same message as before, cause is the blocked StageWorkResult', () => {
  const fix: Extract<StageWorkResult, { kind: 'blocked' }> = {
    kind: 'blocked',
    reason: 'rebase conflict',
  };
  const err = ciFixFailedError(fix);
  assert.equal(err.message, 'worker CI fix failed: rebase conflict');
  assert.equal(err.cause, fix);
});

test('reviewFailedError: same message as before, cause is the blocked StageWorkResult', () => {
  const review: Extract<StageWorkResult, { kind: 'blocked' }> = {
    kind: 'blocked',
    reason: 'push rejected',
  };
  const err = reviewFailedError(review);
  assert.equal(err.message, 'reviewer failed: push rejected');
  assert.equal(err.cause, review);
});

// ---- no-changes tasks & nothing-to-ship groups ---------------------------
// Regression: a task that legitimately requires no code changes (verification-only, or the change
// already exists) used to block its whole group — the empty manifest was misdiagnosed as a
// weak-model failure, and a group whose branch added no commits died at `gh pr create`.

test('group mode: a trailing no-changes task completes without finalizeCommit and the group PR ships the earlier commit', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    prNumber: 42,
    workerResults: [
      okWorker(),
      { kind: 'no-changes', reason: 'verified in prod, fix already live' },
    ],
  });
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [] });
  const ready = makeGraph([twoTaskGroup()], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator, github, graph: ready.graph, autoMerge: true }),
  );
  const result = await loop.run();

  assert.equal(calls.runWorker.length, 2, 'both tasks ran a Worker pass');
  assert.equal(
    calls.finalizeCommit.length,
    1,
    'only the committing task finalizes — no --amend for the no-changes task',
  );
  assert.equal(calls.openPr.length, 1, "the group PR still ships the first task's commit");
  assert.deepEqual(
    ghCalls.mergePr.map((c) => c.pr),
    [42],
  );
  assert.equal(result.outcomes[0]?.status, 'merged', 'clean terminal — nothing was dropped');
  if (result.outcomes[0]?.status === 'merged') assert.equal(result.outcomes[0].pr, 42);
  assert.equal(result.kind, 'success');
});

test('group mode: an all-no-changes group completes as merged with no PR instead of blocking', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    workerResults: [
      { kind: 'no-changes', reason: 'first already done' },
      { kind: 'no-changes', reason: 'second already done' },
    ],
  });
  // The branch adds no commits over the base, so the adapter reports nothing to ship.
  const nothingToShip: WorkLoopOrchestrator = {
    ...orchestrator,
    openPr: async () => 'nothing-to-ship',
  };
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [] });
  const ready = makeGraph([twoTaskGroup()], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({ orchestrator: nothingToShip, github, graph: ready.graph, autoMerge: true }),
  );
  const result = await loop.run();

  assert.equal(calls.finalizeCommit.length, 0, 'nothing was committed');
  assert.deepEqual(ghCalls.mergePr, [], 'no PR exists, so nothing merges');
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.status, 'merged');
  if (result.outcomes[0]?.status === 'merged') {
    assert.equal(result.outcomes[0].pr, null, 'the PR-less terminal is explicit');
  }
  assert.equal(result.kind, 'success', 'a legitimately empty group must not block the run');
});

test('prPerTask: a final no-changes task with nothing to ship completes the group without a PR', async () => {
  const { orchestrator, calls } = makeOrchestrator({
    workerResults: [{ kind: 'no-changes', reason: 'nothing to do' }],
  });
  const nothingToShip: WorkLoopOrchestrator = {
    ...orchestrator,
    openPr: async () => 'nothing-to-ship',
  };
  const { github, calls: ghCalls } = makeGithub({ checks: [ciSuccess], threads: [] });
  const ready = makeGraph([group('solo')], { completeAfter: 1 });
  const loop = new WorkLoop(
    makeDeps({
      orchestrator: nothingToShip,
      github,
      graph: ready.graph,
      autoMerge: true,
      prPerTask: true,
    }),
  );
  const result = await loop.run();

  assert.equal(calls.finalizeCommit.length, 0);
  assert.deepEqual(ghCalls.mergePr, []);
  assert.equal(result.outcomes[0]?.status, 'merged');
  if (result.outcomes[0]?.status === 'merged') assert.equal(result.outcomes[0].pr, null);
  assert.equal(result.kind, 'success');
});

test('noChangesDelivery: empty changes, progress entry names the task and the reason', () => {
  const g = group('gamma');
  const t = g.tasks[0];
  assert.ok(t);
  const d = noChangesDelivery(g, t, 'already implemented');
  assert.equal(d.branch, 'aitm/gamma');
  assert.deepEqual(d.changes, []);
  assert.deepEqual(d.progressEntries, ['- t (no code changes: already implemented)']);
});

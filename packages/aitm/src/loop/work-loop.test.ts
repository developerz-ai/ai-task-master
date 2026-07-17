import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed } from '../github/errors.ts';
import type { CiResult, MergeMethod } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import { renderPlanMarkdown } from '../plan/plan-markdown.ts';
import type { PrGroup, RunState, Task } from '../state/schema.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import type { Checkout } from '../workspace/in-place-checkout.ts';
import { DEFAULT_MAX_CI_FIX_ATTEMPTS } from './constants.ts';
import type { SelfReviewResult } from './self-review.ts';
import type { StageWorkResult } from './stage-handlers.ts';
import {
  type CheckoutHome,
  mergeDeliveries,
  recoveredDelivery,
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
  finalizeCommit: { group: PrGroup; checkoutPath: string }[];
  openPr: { group: PrGroup; baseBranch: string; delivery: WorkerDelivery }[];
  runReviewer: { pr: number; threads: ReviewThread[]; checkout: Checkout }[];
  runCiFix: { group: PrGroup; pr: number; baseBranch: string }[];
  addressReviews: { pr: number; threads: ReviewThread[] }[];
  selfReview: SelfReviewInvocation[];
};

type WorkerInvocationCall = { group: PrGroup; task?: Task; checkout: Checkout; baseBranch: string };

function makeOrchestrator(
  config: {
    workerResults?: WorkerResult[];
    reviewerResult?: ReviewerResult;
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
    runReviewer: [],
    runCiFix: [],
    addressReviews: [],
    selfReview: [],
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
    finalizeCommit: async (g, _d, checkoutPath) => {
      calls.finalizeCommit.push({ group: g, checkoutPath });
      return `sha-${g.id}`;
    },
    openPr: async (g, d, baseBranch) => {
      calls.openPr.push({ group: g, baseBranch, delivery: d });
      config.events?.push(`openPr:${g.branch}`);
      return pullRequest(config.prNumber ?? 42, config.headRefName ?? `aitm/${g.id}`);
    },
    runReviewer: async (input) => {
      calls.runReviewer.push(input);
      return config.reviewerResult ?? ({ kind: 'ok', resolutions: [] } satisfies ReviewerResult);
    },
    runCiFix: async ({ group, pr, baseBranch }) => {
      calls.runCiFix.push({ group, pr, baseBranch });
      return ciFixQueue.shift() ?? { kind: 'ok' };
    },
    addressReviews: async ({ pr, threads }) => {
      calls.addressReviews.push({ pr, threads });
      return config.addressReviewsResult ?? { kind: 'ok' };
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
  };
  return { github, calls };
}

type HomeCalls = {
  acquire: string[];
  release: string[];
  activeAtAcquire: number[];
  resetToBase: { groupId: string; branch: string; baseBranch: string }[];
};

// `resetToBase: true` mounts the base-fresh-per-task seam so prPerTask + autoMerge branches each task
// off the merged base; omitted (default) leaves the home without it, exercising the single-branch
// fallback. `events` is a shared ordering log across stubs.
function makeHome(opts: { resetToBase?: boolean; events?: string[] } = {}): {
  home: CheckoutHome;
  calls: HomeCalls;
  live: () => number;
} {
  const live = new Set<string>();
  const calls: HomeCalls = { acquire: [], release: [], activeAtAcquire: [], resetToBase: [] };
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
  assert.equal(orchCalls.runReviewer.length, 0, 'reviewer not invoked when no threads');
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

test('CI-fix cap: the budget is per driveStages run — a resumed run starts fresh (issue #128)', async () => {
  // The counter is in-memory per invocation: a later run (resume) is not permanently barred from
  // retrying. Two separate loops over the same red group each get their own N-fix budget.
  const g = redCiGroup('cap-resume', 15);
  for (const _pass of [1, 2]) {
    const { orchestrator, calls: orchCalls } = makeOrchestrator({ prNumber: 15 });
    const { github } = makeGithub({ checks: Array(4).fill(ciFailure), threads: [] });
    const loop = new WorkLoop(
      makeDeps({ orchestrator, github, autoMerge: true, maxCiFixAttempts: 1 }),
    );
    await loop.runGroup(g);
    assert.equal(orchCalls.runCiFix.length, 1, 'each run gets a fresh single-attempt budget');
  }
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

test('home.release fires even when orchestrator throws', async () => {
  const orchestrator: WorkLoopOrchestrator = {
    runWorker: async () => {
      throw new Error('worker exploded');
    },
    finalizeCommit: async () => 'sha',
    openPr: async () => pullRequest(1),
    runReviewer: async () => ({ kind: 'ok', resolutions: [] }),
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
    runReviewer: async () => ({ kind: 'ok', resolutions: [] }),
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
  // Update calls in this path: in-progress, task-done, awaiting-pr — none should touch sessionCount.
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

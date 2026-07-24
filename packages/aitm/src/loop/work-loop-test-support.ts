// Stub builders shared by work-loop.test.ts (group-as-PR/shared orchestration) and
// pr-per-task-mode.test.ts (the prPerTask mode extracted from work-loop.ts). Both drive the same
// WorkLoop through its public run()/runGroup(), so they need the same port fakes; kept here once
// instead of duplicated per test file.

import type { PrGroup } from '../domain/pr-group.ts';
import type { Task } from '../domain/task.ts';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';
import { CiFailed } from '../github/errors.ts';
import type { CiResult, MergeMethod } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import { renderPlanMarkdown } from '../plan/plan-markdown.ts';
import { CURRENT_SCHEMA_VERSION, type RunState } from '../state/schema.ts';
import type { WorkerResult } from '../subagents/worker.ts';
import type { Checkout } from '../workspace/in-place-checkout.ts';
import type { SelfReviewResult } from './self-review.ts';
import type { StageWorkResult } from './stage-handlers.ts';
import type {
  CheckoutHome,
  SelfReviewInvocation,
  WorkLoopDeps,
  WorkLoopGithub,
  WorkLoopGraph,
  WorkLoopOrchestrator,
  WorkLoopPrContext,
  WorkLoopState,
} from './work-loop.ts';

export function group(id: string, overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id,
    title: id,
    tasks: [{ id: 't1', text: 't', complexity: 'normal', done: false }],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    stage: 'pending',
    reviewGraceApplied: false,
    ...overrides,
  };
}

export function twoTaskGroup(): PrGroup {
  return group('multi', {
    tasks: [
      { id: 'a', text: 'first task', complexity: 'normal', done: false },
      { id: 'b', text: 'second task', complexity: 'complex', done: false },
    ],
  });
}

export function delivery(): WorkerDelivery {
  return {
    branch: 'aitm/x',
    draftCommitMessage: 'feat: x',
    changes: [{ path: 'a.ts', kind: 'create', summary: 'created a' }],
    progressEntries: ['- did x'],
  };
}

export function pullRequest(number: number, headRefName = 'aitm/x'): PullRequest {
  return {
    number,
    state: 'OPEN',
    url: `https://github.com/o/r/pull/${number}`,
    headRefName,
    baseRefName: 'main',
  };
}

export function baseState(): RunState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
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
      prPerTask: false,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 2,
    },
  };
}

export type OrchestratorCalls = {
  runWorker: WorkerInvocationCall[];
  finalizeCommit: { group: PrGroup; checkoutPath: string; taskId?: string }[];
  openPr: { group: PrGroup; baseBranch: string; delivery: WorkerDelivery }[];
  runCiFix: { group: PrGroup; pr: number; baseBranch: string }[];
  addressReviews: { pr: number; threads: ReviewThread[] }[];
  selfReview: SelfReviewInvocation[];
  releaseGroup: string[];
};

export type WorkerInvocationCall = {
  group: PrGroup;
  task?: Task;
  checkout: Checkout;
  baseBranch: string;
  signal?: AbortSignal;
};

export function makeOrchestrator(
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
export function makeAddressedStore(): WorkLoopPrContext {
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

export type GithubCalls = {
  defaultBranch: number;
  waitForChecks: number[];
  listUnresolvedThreads: number[];
  mergePr: { pr: number; method: MergeMethod }[];
};

export const ciSuccess: CiResult = { state: 'success', failedChecks: [] };
export const ciFailure: CiResult = {
  state: 'failure',
  failedChecks: [{ name: 'test', status: 'failure' }],
};

export function makeGithub(
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

export type HomeCalls = {
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
export function makeHome(
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

export function makeState(seed: PrGroup[] = []): {
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

export function makeGraph(
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

export function makeDeps(
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
export function steppedClock(stepMs: number): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

// docs/architecture.md (WorkLoop row), docs/commands/start.md §Flow
// Drives the Orchestrator group-by-group. Extended for concurrent execution:
//
//   while !plan.isComplete():
//     ready = planGraph.ready()
//     batch = ready.slice(0, free worker slots)
//     await Promise.all(batch.map(g => runGroup(g)))
//
// Each runGroup acquires the checkout home's single slot, runs Worker, and on PR open hands off to
// the merge-pr flow (CI wait + Reviewer + GitHubClient.mergePr).
//
// Deps are structural ports — concrete classes (Orchestrator, GitHubClient, StateStore,
// InPlaceCheckout, PlanGraph) satisfy them at runtime; tests pass literal stubs.

import { DEFAULT_MAX_CI_FIX_ATTEMPTS } from '../config/defaults.ts';
import type { GroupStage, PrGroup, PrGroupStatus } from '../domain/pr-group.ts';
import type { Task } from '../domain/task.ts';
import type { FileChange, WorkerDelivery } from '../domain/worker-delivery.ts';
import type { CiResult, MergeMethod, Sleep } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import { phaseForStage, type StepCounterFn } from '../observability/run-step.ts';
import { formatDuration, type RunStep } from '../observability/step-progress.ts';
import type { PlanMarkdownGroup } from '../plan/plan-markdown.ts';
import type { RunState } from '../state/schema.ts';
import type { WorkerResult } from '../subagents/worker.ts';
import { type BranchCleanup, branchCleanupMessage } from '../workspace/branch-cleanup.ts';
import { DirtyWorkingTree } from '../workspace/dirty-tree.ts';
import type { Checkout } from '../workspace/in-place-checkout.ts';
import { describeError } from './adapter-support.ts';
import { chargeCiFixAttempt } from './ci-outcome-policy.ts';
import { Mutex } from './mutex.ts';
import { type PrPerTaskDeps, runPrPerTaskGroup } from './pr-per-task-mode.ts';
import type { SelfReviewResult } from './self-review.ts';
import {
  handleAddressingReviews,
  handleCiFailed,
  handlePrOpen,
  handleReadyToMerge,
  handleWaitingCi,
  handleWaitingReviews,
  handleWorking,
  type StageDeps,
  type StageGithub,
  type StageHandler,
  type StageOrchestrator,
  type StageWorkResult,
} from './stage-handlers.ts';

export type WorkerInvocation = {
  group: PrGroup;
  // The specific task being worked this pass. Optional so a caller can run the Worker over the
  // whole group instead of a single task (the prompt falls back to the group goal).
  task?: Task;
  checkout: Checkout;
  baseBranch: string;
  // The run's cancellation signal (WorkLoopDeps.signal), so an abort reaches this pass's in-flight
  // LLM calls — the Coordinator's generation AND the editor fanout (WorkerInput.signal) — instead of
  // only being noticed between groups. Optional: a run started without a signal omits it.
  signal?: AbortSignal;
};

export type ReviewerInvocation = {
  pr: number;
  threads: ReviewThread[];
  checkout: Checkout;
};

export type CiFixInvocation = {
  group: PrGroup;
  pr: number;
  checkout: Checkout;
  baseBranch: string;
};

export type SelfReviewInvocation = {
  group: PrGroup;
  // The just-produced delivery (the work about to become a PR) — context for the review.
  delivery: WorkerDelivery;
  checkout: Checkout;
  baseBranch: string;
};

export type WorkLoopOrchestrator = {
  runWorker(input: WorkerInvocation): Promise<WorkerResult>;
  // `taskId`, when given, is stamped onto the finalized commit as a trailer so CheckoutHome.
  // hasTaskCommit can recognize it on resume (see runOneTask). Optional so existing stubs compile;
  // the real Orchestrator always receives it from runOneTask.
  finalizeCommit(
    group: PrGroup,
    delivery: WorkerDelivery,
    checkoutPath: string,
    taskId?: string,
  ): Promise<string>;
  // 'nothing-to-ship': the group branch adds no commits over the base (every task completed
  // without a commit), so there is nothing to push and no PR to open — the group is done as-is.
  openPr(
    group: PrGroup,
    delivery: WorkerDelivery,
    baseBranch: string,
  ): Promise<PullRequest | 'nothing-to-ship'>;
  // Pre-PR self-review: adversarially review + verify + fix the just-committed diff, committing any
  // fixes onto the group branch BEFORE openPr. Optional so existing stubs compile and so a run with
  // selfReview disabled never invokes it; when absent, the PR opens exactly as before. Never blocks —
  // the WorkLoop logs the outcome and opens the PR regardless (external CI is the backstop).
  selfReview?(input: SelfReviewInvocation): Promise<SelfReviewResult>;
  // ci-failed stage + autoMergeFlow: download failed logs + comments, run the Worker fix, rebase
  // onto origin/<base> and force-with-lease push. ok → CI re-runs; blocked → couldn't land the fix.
  runCiFix(input: CiFixInvocation): Promise<StageWorkResult>;
  // addressing-reviews stage + autoMergeFlow: run the Reviewer over the given threads and push its
  // code fixes to the remote. ok → threads handled (any fix pushed); blocked → reviewer/push error.
  addressReviews(input: ReviewerInvocation): Promise<StageWorkResult>;
  // The run is finished with this group — merged, blocked, or handed over to the merge-pr flow — and
  // will never schedule it again (ready() only picks 'pending' groups). Whatever the orchestrator
  // cached for it can go: the real bridge holds a full Worker conversation and a CI-fix handle per
  // group, so without this a twenty-group run ends holding twenty conversations it can never reuse.
  // Optional: stubs that cache nothing omit it.
  releaseGroup?(groupId: string): void;
};

export type WorkLoopGithub = {
  defaultBranch(): Promise<string>;
  // The optional signal cancels the CI poll; an aborted wait comes back without a verdict
  // ('pending'), so every call site re-checks the signal before acting on the result.
  waitForChecks(pr: number, signal?: AbortSignal): Promise<CiResult>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number, method: MergeMethod, opts?: { admin?: boolean }): Promise<void>;
  // Login `gh` is authenticated as, forwarded to the addressing-reviews dedup so it can skip a thread
  // it already replied to (self-healing across a crash before the addressed record lands). Optional —
  // stubs that don't drive the review loop omit it; the real GitHubClient supplies it.
  authenticatedLogin?(): Promise<string>;
};

export type CheckoutHome = {
  acquire(groupId: string, branch: string, baseBranch: string): Promise<Checkout>;
  release(groupId: string): Promise<void>;
  // Re-point the group's checkout to a fresh branch started from the up-to-date remote base
  // (git fetch origin <baseBranch> → checkout -B <branch> origin/<baseBranch>). prPerTask + autoMerge
  // calls it per task so each task's PR branches off the previous task's MERGED result rather than the
  // prior task's tip (which, after a squash merge, would re-include the prior task's changes). Optional:
  // a home that omits it — or a --no-automerge run — keeps the single group branch (documented fallback).
  resetToBase?(groupId: string, branch: string, baseBranch: string): Promise<Checkout>;
  // True when `branch` already carries a commit for this task — detects the crash window between
  // finalizeCommit (the Worker's commit lands) and completeTask (state persists `done`): a resume
  // that finds the commit already there would otherwise re-run the Worker and double it (harmless
  // under squash-merge, wrong under merge/rebase — see runOneTask). Optional: a home without it
  // (test stubs) always re-runs the Worker, byte-identical to pre-fix behavior for everything
  // outside that narrow crash window.
  hasTaskCommit?(branch: string, taskId: string): Promise<boolean>;
  // Retire a group branch whose PR has merged: delete it on origin and locally, moving HEAD off it
  // first when it is the one checked out. Called once per group, right after the merge — otherwise a
  // finished run leaves every group branch behind and parks the operator on the last one. Returns the
  // concrete cleanup result so the caller reports what actually happened (a remote delete is
  // best-effort). Optional: a home without it (test stubs) simply skips the tidy-up.
  discardBranch?(branch: string, baseBranch: string): Promise<BranchCleanup>;
};

export type WorkLoopState = {
  update(mutator: (s: RunState) => RunState): Promise<RunState>;
  // Persist the plan groups after per-task completion; StateStore renders them to plan.md
  // (checkbox markdown). Optional: stubs that don't care about the on-disk plan can omit it.
  writePlan?(groups: readonly PlanMarkdownGroup[]): Promise<void>;
};

export type WorkLoopGraph = {
  ready(): PrGroup[];
  isComplete(): boolean;
};

// Addressed-thread bookkeeping for the addressing-reviews stage so its loop terminates across
// re-polls (a replied-but-unresolved thread isn't re-processed forever). PrContextStore satisfies
// it. Optional on the deps: stubs that don't drive the review loop can omit it.
export type WorkLoopPrContext = {
  readAddressedThreads(pr: number): Promise<Set<string>>;
  recordAddressedThreads(pr: number, ids: readonly string[]): Promise<void>;
};

// Result of a run-level budget check (issue #190). `exceeded` carries the human reason the run
// stops; the run-loop adapter builds the check from the usage ledger + resolved ceilings.
export type BudgetStatus = { exceeded: true; reason: string } | { exceeded: false };

export type WorkLoopDeps = {
  orchestrator: WorkLoopOrchestrator;
  github: WorkLoopGithub;
  state: WorkLoopState;
  home: CheckoutHome;
  graph: WorkLoopGraph;
  // Drives the addressing-reviews dedup. Optional — without it the review loop still terminates
  // once threads are resolved, but a replied-but-unresolved thread would be re-handled each poll.
  prContext?: WorkLoopPrContext;
  concurrency: number;
  autoMerge: boolean;
  // Run the pre-PR self-review pass before every openPr (default true — omitted is on). False → the
  // pass never runs and the flow is byte-identical to the pre-selfReview behavior. Only has an effect
  // when orchestrator.selfReview is also wired. See maybeSelfReview / src/loop/self-review.ts.
  selfReview?: boolean;
  // When true, open (and, under autoMerge, merge) a PR after each task. Default (false/omitted)
  // is aitm's group-as-PR mode: a single PR per group, opened after the final task lands.
  prPerTask?: boolean;
  maxSessions: number | null;
  // Cap on CI-fix passes per group per driveStages run. Optional so existing test stubs keep
  // compiling; the class applies DEFAULT_MAX_CI_FIX_ATTEMPTS when omitted. See issue #128.
  maxCiFixAttempts?: number;
  mergeMethod?: MergeMethod;
  // When true, merges pass `gh pr merge --admin` to override base-branch policy. Default false.
  adminMerge?: boolean;
  // Seed for resume: when WorkLoop is constructed after a previous run, pass
  // RunState.sessionCount so the in-memory counter and the persisted counter agree.
  initialSessionCount?: number;
  // Delay primitive for the post-CI review grace (handleWaitingCi). Optional — defaults to a real
  // timer in production; tests inject a no-op so they don't block on the 2-minute wait.
  sleep?: Sleep;
  // Harness narration (silent-run fix): one line per group stage transition, wired by the adapter
  // to the cyan [aitm] console stream so the operator sees the loop driving each group
  // (working → pr-open → waiting-ci → …). Optional — tests and older callers omit it. The RunStep
  // stamps the phase + N/M step counter into the line (claudetm parity); harnessProgress renders it.
  progress?: (message: string, step?: RunStep, opts?: { milestone?: boolean }) => void;
  // Resolve the N/M step counter for a group/task, injected by the adapter (it owns the plan totals
  // + prPerTask). Optional — omitted → the phase word still shows, without a counter.
  stepCounter?: StepCounterFn;
  // Abort handle threaded from the CLI's SIGINT/SIGTERM handler (cli.ts → RunLoopInput.signal →
  // run-loop-adapter.ts). Checked at each loop iteration boundary so a cancelled run reports
  // `{ kind: 'cancelled' }` (exit 2) instead of surfacing whatever abort-induced group failure
  // `runGroup`'s catch produced as `blocked` (exit 1). Optional — omitted → no cancellation check,
  // byte-identical to pre-signal behavior. See docs/plans/.../02-signal-cancellation-cleanup.md.
  signal?: AbortSignal;
  // Run-level cost/token budget check (issue #190). Consulted at each group-batch boundary BEFORE new
  // work is dispatched (never mid-commit); an exceeded result stops the run and blocks with the
  // reason. Optional — omitted → no ceiling, byte-identical to before. Built by run-loop-adapter's
  // makeBudgetCheck from the usage ledger + resolved maxCostUsd/maxTotalTokens.
  budget?: () => Promise<BudgetStatus>;
  // Clock for task/group timing lines (`task done in 7.2m`, group totals at merge). Optional —
  // defaults to the wall clock; tests inject a stepped fake so duration assertions are
  // deterministic instead of racing the real clock.
  now?: () => number;
};

export type GroupOutcome =
  // `pr: null` marks a group that completed with nothing to ship — every task finished but the
  // branch adds no commits over the base (e.g. all tasks were verification-only), so no PR exists.
  | { groupId: string; status: 'merged'; pr: number | null }
  | { groupId: string; status: 'awaiting-pr'; pr: number }
  // A group that opened (and, under autoMerge, merged) a PR for its committed tasks but left at least
  // one task undone — a mid-group block after earlier tasks landed, where workTasks ships the
  // committed work rather than stranding it on the branch. NOT a clean terminal: the dropped task(s)
  // are never rescheduled (a shipped group leaves PlanGraph.ready(), and resume re-enters past
  // 'working'), so finalResult reports it as non-success instead of exiting 0 on lost work. `pr` is
  // the shipped PR; `dropped` names the still-undone task ids.
  | { groupId: string; status: 'partial'; pr: number; dropped: string[] }
  | { groupId: string; status: 'blocked'; reason: string };

export type WorkLoopResult =
  | { kind: 'success'; outcomes: GroupOutcome[] }
  | { kind: 'awaiting-pr'; prs: number[]; outcomes: GroupOutcome[] }
  | { kind: 'blocked'; reason: string; outcomes: GroupOutcome[] }
  | { kind: 'session-cap'; outcomes: GroupOutcome[] }
  // User-cancelled (e.g. SIGINT) mid-flow. Maps to exit code 2 — distinct from a `blocked`
  // run (exit 1). Currently produced only by the `merge-pr` take-over loop on an aborted signal.
  | { kind: 'cancelled'; outcomes: GroupOutcome[] };

// One task's outcome from runOneTask: a fresh commit (or synthetic delivery, for a
// resume-skipped/no-changes task) plus the group with that task marked done, or the reason a Worker
// pass couldn't complete. Shared by both delivery modes — driveStages' workTasks loops it per group,
// pr-per-task-mode's runPrPerTaskGroup opens a PR after each result.
export type RunOneTaskResult =
  | { kind: 'ok'; group: PrGroup; delivery: WorkerDelivery }
  | { kind: 'blocked'; reason: string };

const DEFAULT_MERGE_METHOD: MergeMethod = 'squash';

// Merge every task's delivery in a group into one, so PR composition (openPr → composePr) sees the
// whole group's changes, not just the last task's. All tasks share the group branch; `changes` are
// unioned per path (first touch keeps its `kind` — a create stays a create even if a later task
// modifies the file — while the latest `summary` wins); messages and progress entries concatenate
// in task order. A single delivery is returned unchanged. Exported for unit testing.
export function mergeDeliveries(deliveries: readonly WorkerDelivery[]): WorkerDelivery {
  const [first] = deliveries;
  if (first === undefined) throw new Error('mergeDeliveries requires at least one delivery');
  if (deliveries.length === 1) return first;
  const byPath = new Map<string, FileChange>();
  for (const delivery of deliveries) {
    for (const change of delivery.changes) {
      const prior = byPath.get(change.path);
      byPath.set(change.path, prior ? { ...change, kind: prior.kind } : change);
    }
  }
  return {
    branch: first.branch,
    draftCommitMessage: deliveries.map((d) => d.draftCommitMessage).join('\n\n'),
    changes: [...byPath.values()],
    progressEntries: deliveries.flatMap((d) => d.progressEntries),
  };
}

// Synthesize a delivery for work recovered from a prior run: some tasks are already `done` — their
// commits persist on the branch the checkout home reuses on resume — but no PR was opened and this
// pass produced no fresh delivery (it blocked, or every task was already done). A done task only
// reaches that state after its commit is finalized, so `done` is a reliable proxy for "committed";
// this lets openPr surface the recovered work instead of stranding it. Returns null when a PR
// already exists or nothing has been committed (a genuinely fresh, first-task-blocked run). The
// changed-file list is empty — the commits exist on the branch, but this pass didn't produce the
// per-file detail — so composePr titles/bodies from the group goal. Exported for unit testing.
export function recoveredDelivery(group: PrGroup): WorkerDelivery | null {
  if (group.pr !== null) return null;
  const done = group.tasks.filter((task) => task.done);
  if (done.length === 0) return null;
  return {
    branch: group.branch ?? `aitm/${group.id}`,
    draftCommitMessage: group.title,
    changes: [],
    progressEntries: done.map((task) => `- ${task.text}`),
  };
}

// Synthetic delivery for a task whose commit is already on the branch — runOneTask's
// hasTaskCommit skip, the same crash window recoveredDelivery covers at the group level (a resumed
// run whose Worker pass never happened this time). No Worker ran, so there is no fresh
// draftCommitMessage/changed-file detail — only the task text. Exported for unit testing.
export function alreadyCommittedDelivery(group: PrGroup, task: Task): WorkerDelivery {
  return {
    branch: group.branch ?? `aitm/${group.id}`,
    draftCommitMessage: task.text,
    changes: [],
    progressEntries: [`- ${task.text}`],
  };
}

// Synthetic delivery for a task the Worker explicitly declared needs no code changes
// (FileManifest.noChangesNeeded): the task completes without a commit, contributing only its
// progress entry to the merged group delivery. Exported for unit testing.
export function noChangesDelivery(group: PrGroup, task: Task, reason: string): WorkerDelivery {
  return {
    branch: group.branch ?? `aitm/${group.id}`,
    draftCommitMessage: task.text,
    changes: [],
    progressEntries: [`- ${task.text} (no code changes: ${reason})`],
  };
}

// Mutable scratch the stage dispatcher threads through one group-run. `group` is the authoritative
// in-memory copy the bridges keep current (tasks marked done by work(), pr set by openPr()); the
// persisted GroupStage is the dispatcher's job. `delivery` is the merged Worker delivery work()
// produced (every task's changes), consumed by openPr(). `blockedReason` carries the human reason a
// handler yielded 'blocked' (lost otherwise, since handlers return only the next stage).
type StageCtx = {
  group: PrGroup;
  delivery: WorkerDelivery | null;
  blockedReason: string | undefined;
  // Ids of tasks work() dropped this pass while still shipping a PR for earlier committed tasks (a
  // mid-group block, or a resume that recovers prior commits but can't finish a later task). Set only
  // at those active-drop points — a resume that re-enters past 'working' never runs work(), so it
  // stays empty and the group keeps its clean terminal. Non-empty → terminalOutcome yields 'partial'
  // so finalResult reports the dropped work instead of exiting 0.
  dropped: string[];
  // CI-fix passes dispatched for this group, seeded from the persisted PrGroup.ciFixAttempts and
  // mirrored back to state on each increment, so the recovery budget survives a resume: a
  // crash-resumed group continues counting from where it left off instead of restarting at zero and
  // cycling forever on an unfixable red PR (issue #128).
  fixAttempts: number;
};

// The reason carried by a group the run's signal cancelled. run() re-checks the signal at the batch
// boundary and reports the whole run `cancelled` (exit 2), so this only ever surfaces per group.
const RUN_CANCELLED_REASON = 'run cancelled';

// Thrown when a state-write fails *after* an external side effect (openPr/mergePr) already
// succeeded. Carries the real outcome so runGroup doesn't roll the group back to 'blocked'
// and cause a retry to reopen/re-merge work that already landed.
class StateWriteAfterSuccess extends Error {
  constructor(
    readonly outcome: GroupOutcome,
    override readonly cause: unknown,
  ) {
    super(
      `state write failed after external success: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export class WorkLoop {
  private readonly outcomes: GroupOutcome[] = [];
  private sessionCount: number;
  private readonly maxCiFixAttempts: number;
  // Driver-owned checkout lock: the shared single in-place checkout holds one branch at a time, so
  // the git-mutating checkout→edit→commit critical section (runOneTask) must run for one group at a
  // time even when run() dispatches a batch of ready() groups. Non-git phases (CI waits, PR polling)
  // stay outside it and still overlap. A no-op at concurrency 1. See docs/plans/.../02-*.md (DECISION 1).
  private readonly checkoutMutex = new Mutex();
  // Group start times for the `group … merged in Ns` total (claudetm parity), keyed by group id —
  // set once at runGroup entry, read wherever a group reaches its merged terminal (driveStages'
  // stage transition, or openAndMaybeMerge's per-task merge under prPerTask). Concurrent groups
  // never collide: PrGroup ids are unique within a run (see StateStore).
  private readonly groupStartedAt = new Map<string, number>();

  constructor(private readonly deps: WorkLoopDeps) {
    this.sessionCount = deps.initialSessionCount ?? 0;
    this.maxCiFixAttempts = deps.maxCiFixAttempts ?? DEFAULT_MAX_CI_FIX_ATTEMPTS;
  }

  async run(): Promise<WorkLoopResult> {
    const { graph, maxSessions, concurrency, signal, budget } = this.deps;

    while (!graph.isComplete()) {
      if (signal?.aborted) {
        return { kind: 'cancelled', outcomes: this.outcomes.slice() };
      }
      if (this.sessionCapReached(maxSessions)) {
        return { kind: 'session-cap', outcomes: this.outcomes.slice() };
      }
      // Run-level cost/token ceiling (issue #190): consult the live usage ledger BEFORE dispatching
      // the next batch, so a crossed ceiling stops new work at a batch boundary — never mid-commit.
      if (budget) {
        const status = await budget();
        // A SIGINT during the async ledger lookup must still report cancelled (exit 2), not a budget
        // block (exit 1) or another dispatched batch — mirror the top-of-loop / post-batch re-check.
        if (signal?.aborted) {
          return { kind: 'cancelled', outcomes: this.outcomes.slice() };
        }
        if (status.exceeded) {
          return { kind: 'blocked', reason: status.reason, outcomes: this.outcomes.slice() };
        }
      }
      const ready = graph.ready();
      if (ready.length === 0) break;
      const batchSize = this.nextBatchSize(ready.length, concurrency, maxSessions);
      if (batchSize === 0) {
        return { kind: 'session-cap', outcomes: this.outcomes.slice() };
      }
      const batch = ready.slice(0, batchSize);
      // Charge a session per group AS IT STARTS, persisted incrementally — not the whole batch
      // upfront. batchSize already fits the remaining budget (nextBatchSize), so the per-group
      // bumps sum to ≤ it; and a crash mid-batch leaves the persisted count at the groups that
      // actually started, so a resume never inherits an inflated batch.length that trips maxSessions
      // before the still-unrun groups get their turn.
      // allSettled, not Promise.all: runGroup swallows its own failures into an outcome and never
      // rejects, so the only rejection here is a counter-write failure in incrementSessionCount.
      // Promise.all would surface that immediately while sibling groups — already past their own
      // increment and into runGroup's Git/PR side effects — are still in flight, letting run()'s
      // caller start failure cleanup over live work. Wait for every started group to settle, THEN
      // rethrow the first counter-write failure.
      const settled = await Promise.allSettled(
        batch.map(async (g) => {
          await this.incrementSessionCount();
          await this.runGroup(g);
        }),
      );
      for (const outcome of settled) {
        if (outcome.status === 'rejected') throw outcome.reason;
      }
      // Re-check post-batch: an abort mid-batch aborts each group's in-flight LLM calls — the
      // signal reaches them via runOneTask → WorkerInvocation.signal → WorkerInput.signal (the
      // editor fanout's shared controller) — which runGroup's catch would otherwise report as
      // `blocked` (exit 1). A cancelled run must report cancelled (exit 2) regardless of the
      // abort-induced per-group outcome.
      if (signal?.aborted) {
        return { kind: 'cancelled', outcomes: this.outcomes.slice() };
      }
    }

    return this.finalResult();
  }

  // Run a single group. The group-as-PR default drives the PR lifecycle through the persisted
  // stage machine (driveStages); prPerTask opens — and under autoMerge merges — a PR per task
  // (runPrPerTaskGroup, pr-per-task-mode.ts). Both acquire a checkout, persist an in-progress
  // entry, and release on exit.
  async runGroup(group: PrGroup): Promise<void> {
    const branch = group.branch ?? `aitm/${group.id}`;
    this.groupStartedAt.set(group.id, this.now());
    let acquired = false;
    try {
      const baseBranch = await this.deps.github.defaultBranch();
      // Resume at the persisted stage; a fresh/pending group starts at 'working'. prPerTask
      // tracks completion per task (task.done), not via the per-group stage, so it omits it.
      const startStage = resumeStage(group);
      await this.markStatus(
        group.id,
        'in-progress',
        this.deps.prPerTask ? { branch } : { branch, stage: startStage },
      );
      const checkout = await this.deps.home.acquire(group.id, branch, baseBranch);
      acquired = true;
      try {
        if (this.deps.prPerTask) {
          await runPrPerTaskGroup(
            this.buildPrPerTaskDeps(),
            { ...group, branch },
            checkout,
            baseBranch,
          );
        } else {
          const outcome = await this.driveStages(
            { ...group, branch, stage: startStage },
            checkout,
            baseBranch,
          );
          this.outcomes.push(outcome);
        }
      } finally {
        await this.deps.home.release(group.id);
        acquired = false;
      }
    } catch (err) {
      if (acquired) {
        // best-effort release if the group-run itself threw before the inner finally ran;
        // the inner finally would have run already in normal flow, so this is defensive.
        try {
          await this.deps.home.release(group.id);
        } catch {
          /* swallow */
        }
      }
      // A dirty working tree is a RUN precondition, not this group's failure: every group would
      // refuse identically, so blocking them one by one buries the message behind N copies and
      // rewrites plan state over work the operator was told aitm would not touch. Abort the run.
      if (err instanceof DirtyWorkingTree) throw err;
      if (err instanceof StateWriteAfterSuccess) {
        // External side effect (openPr/mergePr) already succeeded; persist failed.
        // Keep the real outcome so a retry doesn't reopen or re-merge.
        this.outcomes.push(err.outcome);
        return;
      }
      const reason = describeError(err).message;
      // Surface the reason live — this catch path (e.g. an openPr throw at pr-open) otherwise blocks
      // the group SILENTLY: unlike driveStages' in-loop block, no progress line is emitted, so the run
      // log shows a group vanish with no cause. The reason still rides the outcome for the run summary.
      this.deps.progress?.(
        `group ${group.id}: → blocked (${reason})`,
        this.stepFor(group.id, 'blocked'),
      );
      try {
        await this.markStatus(group.id, 'blocked');
      } catch {
        /* swallow secondary failures */
      }
      this.outcomes.push({ groupId: group.id, status: 'blocked', reason });
    } finally {
      // Every exit — merged, blocked, awaiting-pr, cancelled, or the rethrown run precondition — is
      // the last this run sees of the group, so this is where its cached conversations are dropped.
      this.deps.orchestrator.releaseGroup?.(group.id);
    }
  }

  // Bridge the WorkLoop's ports and shared bookkeeping to pr-per-task-mode.ts's narrow surface —
  // the prPerTask analog of buildStageDeps. Rebuilt per group-run so `outcomesFor`/`pushOutcome`
  // close over the run's own `this.outcomes`.
  private buildPrPerTaskDeps(): PrPerTaskDeps {
    return {
      orchestrator: this.deps.orchestrator,
      github: this.deps.github,
      home: this.deps.home,
      autoMerge: this.deps.autoMerge,
      adminMerge: this.deps.adminMerge ?? false,
      mergeMethod: this.deps.mergeMethod ?? DEFAULT_MERGE_METHOD,
      maxCiFixAttempts: this.maxCiFixAttempts,
      ...(this.deps.signal ? { signal: this.deps.signal } : {}),
      ...(this.deps.progress ? { progress: this.deps.progress } : {}),
      runOneTask: (group, task, checkout, baseBranch) =>
        this.runOneTask(group, task, checkout, baseBranch),
      maybeSelfReview: (group, delivery, checkout, baseBranch) =>
        this.maybeSelfReview(group, delivery, checkout, baseBranch),
      markStatus: (id, status, patch) => this.markStatus(id, status, patch),
      persistAfterSideEffect: (outcome, write) => this.persistAfterSideEffect(outcome, write),
      discardMergedBranch: (groupId, branch) => this.discardMergedBranch(groupId, branch),
      stepFor: (groupId, phase, task) => this.stepFor(groupId, phase, task),
      groupElapsedLabel: (groupId) => this.groupElapsedLabel(groupId),
      outcomesFor: (groupId) => this.outcomes.filter((o) => o.groupId === groupId),
      pushOutcome: (outcome) => this.outcomes.push(outcome),
    };
  }

  // Stage dispatcher — claudetm's `_run_workflow_cycle` (core/orchestrator.py). Advance one
  // transition per iteration off the persisted GroupStage, persisting after each, until a
  // terminal stage (`merged`/`blocked`) or — when autoMerge is off — until the PR is open
  // (`waiting-ci`), where it hands off to the merge-pr flow. On resume the group re-enters at
  // its persisted stage, so prior stages (working, pr-open) are never redone.
  private async driveStages(
    group: PrGroup,
    checkout: Checkout,
    baseBranch: string,
  ): Promise<GroupOutcome> {
    const ctx: StageCtx = {
      group,
      delivery: null,
      blockedReason: undefined,
      dropped: [],
      // Seed from the persisted count so a resumed group keeps its remaining budget (issue #128).
      fixAttempts: group.ciFixAttempts ?? 0,
    };
    const deps = this.buildStageDeps(ctx, checkout, baseBranch);
    let stage: GroupStage = group.stage;

    while (true) {
      if (stage === 'merged') return this.mergedOutcome(ctx);
      if (stage === 'blocked') {
        return {
          groupId: ctx.group.id,
          status: 'blocked',
          reason: ctx.blockedReason ?? `group ${ctx.group.id} is blocked`,
        };
      }
      // autoMerge off: stop once the PR is open; runMergePr (or a follow-up run) finishes it.
      if (!this.deps.autoMerge && stage === 'waiting-ci') return this.awaitingPrOutcome(ctx);

      // Cancelled run (SIGINT): stop BEFORE dispatching another handler — the next transitions
      // spend LLM calls (ci-failed, addressing-reviews) or merge the PR (ready-to-merge). The
      // group's persisted stage stays where it is, so a resume re-enters exactly here; run()
      // turns this outcome into `cancelled` (exit 2) at the batch boundary.
      if (this.deps.signal?.aborted) {
        return {
          groupId: ctx.group.id,
          status: 'blocked',
          reason: ctx.blockedReason ?? RUN_CANCELLED_REASON,
        };
      }

      // Cap the CI-fix recovery loop: count each ci-failed dispatch against a budget that now
      // survives resumes (see StageCtx.fixAttempts), and once the cap is exceeded block WITHOUT
      // running the fix session (no LLM call, no push) so an unfixable red PR ends for a human
      // instead of cycling forever — across resumes as well as within one run (issue #128).
      if (stage === 'ci-failed') {
        // Charge one durable fix-attempt slot BEFORE dispatching the fix, so a crash mid-fix can't
        // hand the resumed run a fresh budget — the count is consumed at dispatch and persisted.
        const charge = chargeCiFixAttempt(
          ctx.fixAttempts,
          this.maxCiFixAttempts,
          prNumberOf(ctx.group),
        );
        ctx.fixAttempts = charge.spent;
        ctx.group = { ...ctx.group, ciFixAttempts: ctx.fixAttempts };
        if (charge.kind === 'exhausted') {
          ctx.blockedReason = charge.reason;
          // Flag human-needed so a resume never resurrects this block (normalizeResumeStatus skips
          // it); a transient block, by contrast, is retried on the next `aitm start`.
          ctx.group = { ...ctx.group, stage: 'blocked', humanNeeded: true };
          await this.markStatus(ctx.group.id, 'blocked', {
            stage: 'blocked',
            ciFixAttempts: ctx.fixAttempts,
            humanNeeded: true,
          });
          stage = 'blocked';
          continue;
        }
        await this.markStatus(ctx.group.id, statusForStage(stage), {
          ciFixAttempts: ctx.fixAttempts,
        });
      }

      const handler = handlerFor(stage);
      const prBefore = ctx.group.pr;
      let next: GroupStage;
      try {
        const outcome = await handler(deps, ctx.group);
        // A handler may pair its 'blocked' with the specific reason (which checks failed, a rebase
        // conflict the AI resolver couldn't close, etc.) — surface that instead of the generic
        // blockReasonFor fallback so an operator sees what actually happened.
        if (typeof outcome === 'string') {
          next = outcome;
        } else {
          next = outcome.stage;
          ctx.blockedReason ??= outcome.reason;
        }
      } catch (err) {
        // openPr landed (pr now set) but the handler's own state write failed — preserve the
        // awaiting-pr outcome so a retry doesn't reopen the PR (cf. StateWriteAfterSuccess).
        if (prBefore === null && ctx.group.pr !== null) {
          throw new StateWriteAfterSuccess(this.awaitingPrOutcome(ctx), err);
        }
        throw err;
      }
      if (next === 'blocked') {
        ctx.blockedReason ??= blockReasonFor(stage, ctx.group);
      }
      if (next !== stage) {
        const reason = next === 'blocked' && ctx.blockedReason ? ` (${ctx.blockedReason})` : '';
        const timing =
          next === 'merged' ? ` — done in ${this.groupElapsedLabel(ctx.group.id)}` : '';
        // A merge is the one success worth spotting in a wall of stage lines — render it as a
        // green ★ milestone.
        this.deps.progress?.(
          `group ${ctx.group.id}: ${stage} → ${next}${reason}${timing}`,
          this.stepFor(ctx.group.id, phaseForStage(next)),
          next === 'merged' ? { milestone: true } : undefined,
        );
      }
      ctx.group = { ...ctx.group, stage: next };
      await this.persistStageAfter(stage, next, ctx);
      stage = next;
    }
  }

  // Bridge the WorkLoop's ports to the narrow surfaces the stage handlers drive. The handlers
  // stay checkout-agnostic; this closure owns the checkout, base branch and the per-run StageCtx.
  private buildStageDeps(ctx: StageCtx, checkout: Checkout, baseBranch: string): StageDeps {
    const orchestrator: StageOrchestrator = {
      work: async () => {
        const result = await this.workTasks(ctx.group, checkout, baseBranch);
        if (result.kind === 'blocked') {
          // A task couldn't complete this pass and nothing was committed this pass. If a prior run
          // already committed earlier tasks on the (reused) branch, open a PR for that recovered
          // work instead of stranding it; only block when there is genuinely nothing committed.
          const recovered = recoveredDelivery(ctx.group);
          if (recovered) {
            ctx.delivery = recovered;
            // The recovered PR ships the prior run's committed tasks, but the task that blocked this
            // pass (and any after it) is dropped — mark the group partial, not a clean terminal.
            ctx.dropped = ctx.group.tasks.filter((t) => !t.done).map((t) => t.id);
            return { kind: 'ok' };
          }
          ctx.blockedReason = result.reason;
          return result;
        }
        ctx.group = result.group;
        ctx.delivery = result.delivery;
        ctx.dropped = result.dropped;
        if (result.delivery === null && ctx.group.pr === null) {
          // No new work this pass and no PR. If earlier tasks were already committed by a prior run,
          // open a PR for that recovered work rather than blocking; otherwise there is nothing to
          // open from.
          const recovered = recoveredDelivery(ctx.group);
          if (recovered) {
            ctx.delivery = recovered;
            return { kind: 'ok' };
          }
          const reason = 'all tasks already complete but no pull request was opened';
          ctx.blockedReason = reason;
          return { kind: 'blocked', reason };
        }
        return { kind: 'ok' };
      },
      openPr: async () => {
        if (ctx.delivery === null) {
          throw new Error(`group ${ctx.group.id} reached pr-open without a worker delivery`);
        }
        await this.maybeSelfReview(ctx.group, ctx.delivery, checkout, baseBranch);
        const opened = await this.deps.orchestrator.openPr(ctx.group, ctx.delivery, baseBranch);
        if (opened === 'nothing-to-ship') return null;
        ctx.group = { ...ctx.group, pr: opened.number, prUrl: opened.url };
        return { number: opened.number, url: opened.url };
      },
      fixCi: (group) =>
        this.deps.orchestrator.runCiFix({ group, pr: prNumberOf(group), checkout, baseBranch }),
      addressReviews: (group, threads) =>
        this.deps.orchestrator.addressReviews({ pr: prNumberOf(group), threads, checkout }),
    };
    const authenticatedLogin = this.deps.github.authenticatedLogin?.bind(this.deps.github);
    const github: StageGithub = {
      waitForChecks: (pr, signal) => this.deps.github.waitForChecks(pr, signal),
      listUnresolvedThreads: (pr) => this.deps.github.listUnresolvedThreads(pr),
      mergePr: (pr) =>
        this.deps.github.mergePr(pr, this.deps.mergeMethod ?? DEFAULT_MERGE_METHOD, {
          admin: this.deps.adminMerge ?? false,
        }),
      ...(authenticatedLogin ? { authenticatedLogin } : {}),
    };
    return {
      orchestrator,
      github,
      state: this.deps.state,
      adminMerge: this.deps.adminMerge ?? false,
      ...(this.deps.prContext ? { prContext: this.deps.prContext } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      ...(this.deps.signal ? { signal: this.deps.signal } : {}),
      ...(this.deps.progress
        ? { progress: (message: string) => this.deps.progress?.(message) }
        : {}),
    };
  }

  // Run every not-yet-done task of the group to commits on its branch (no PR), returning a single
  // delivery — the merge of every task's delivery — for openPr, so the composed PR body reflects the
  // whole group's changes rather than only the last task's. Idempotent on resume: tasks already
  // `done` are skipped. If a task blocks after earlier tasks already committed this pass, the
  // committed work still opens a PR (the block is not propagated here); blocking is reserved for when
  // nothing has been committed. A group that ships such a partial PR keeps an undone task, so its
  // terminal outcome is `partial` (see terminalOutcome), not `merged`/`awaiting-pr` — the run reports
  // it as non-success rather than exiting 0 on silently dropped work.
  private async workTasks(
    group: PrGroup,
    checkout: Checkout,
    baseBranch: string,
  ): Promise<
    | { kind: 'ok'; group: PrGroup; delivery: WorkerDelivery | null; dropped: string[] }
    | { kind: 'blocked'; reason: string }
  > {
    let worked = group;
    const deliveries: WorkerDelivery[] = [];
    for (const task of group.tasks) {
      if (task.done) continue;
      const result = await this.runOneTask(worked, task, checkout, baseBranch);
      if (result.kind === 'blocked') {
        // A task couldn't complete. If earlier tasks in this group already committed work on this
        // pass, don't discard it: open a PR for what landed instead of stranding those commits on
        // the branch with no PR. Block outright only when nothing has been committed yet.
        if (deliveries.length > 0) {
          // Ship the earlier tasks' PR, but surface the block live: the still-undone task leaves the
          // group's terminal outcome `partial` (non-success), so the run reflects the dropped work
          // instead of exiting 0 on a green-looking merge with this task's work silently missing.
          this.deps.progress?.(
            `group ${group.id} task ${task.id}: → blocked, shipping partial PR (${result.reason})`,
            this.stepFor(group.id, 'blocked', task),
          );
          return {
            kind: 'ok',
            group: worked,
            delivery: mergeDeliveries(deliveries),
            // Everything still undone this pass — the task that blocked plus any tasks after it that
            // never ran — is dropped from the shipped PR.
            dropped: worked.tasks.filter((t) => !t.done).map((t) => t.id),
          };
        }
        return result;
      }
      worked = result.group;
      deliveries.push(result.delivery);
    }
    return {
      kind: 'ok',
      group: worked,
      delivery: deliveries.length > 0 ? mergeDeliveries(deliveries) : null,
      dropped: [],
    };
  }

  // One task: Worker pass → finalize commit → mark done → persist → re-render plan.md.
  //
  // The Worker pass + commit finalization mutate the shared checkout (branch checkout, editor
  // writes, git commit/amend), so they run inside the driver's checkout mutex: only one group edits
  // and commits at a time, even under a concurrently-dispatched batch (DECISION 1). completeTask is a
  // serialized state write, not a git op, so it stays outside the lock.
  private async runOneTask(
    group: PrGroup,
    task: Task,
    checkout: Checkout,
    baseBranch: string,
  ): Promise<RunOneTaskResult> {
    // Resume idempotency: the Worker's commit for this task may already be on the branch — a crash
    // between finalizeCommit and completeTask (below), or a resumed run reusing the branch across
    // process restarts. Re-running the Worker here would produce a SECOND commit for the same task
    // (harmless under squash-merge, which collapses the group into one commit anyway; a genuine
    // duplicate under merge/rebase, which don't). Detect it and skip straight to completeTask.
    if (await this.deps.home.hasTaskCommit?.(checkout.branch, task.id)) {
      const next = await this.completeTask(group, task.id);
      return { kind: 'ok', group: next, delivery: alreadyCommittedDelivery(group, task) };
    }
    const startedAt = this.now();
    const result = await this.checkoutMutex.runExclusive(async () => {
      const worked = await this.deps.orchestrator.runWorker({
        group,
        task,
        checkout,
        baseBranch,
        ...(this.deps.signal ? { signal: this.deps.signal } : {}),
      });
      if (worked.kind === 'ok') {
        await this.deps.orchestrator.finalizeCommit(group, worked.delivery, checkout.path, task.id);
      }
      return worked;
    });
    if (result.kind === 'no-changes') {
      // The Worker explicitly declared the task needs no code changes. Complete it without a
      // commit — finalizeCommit must NOT run (its `--amend` would rewrite whatever commit happens
      // to sit at the branch tip). The synthetic delivery contributes only its progress entry.
      const next = await this.completeTask(group, task.id);
      this.deps.progress?.(
        `group ${group.id} task ${task.id}: no code changes needed (${result.reason})`,
        this.stepFor(group.id, 'working', task),
      );
      return { kind: 'ok', group: next, delivery: noChangesDelivery(group, task, result.reason) };
    }
    if (result.kind !== 'ok') {
      return { kind: 'blocked', reason: result.kind === 'blocked' ? result.reason : result.error };
    }
    const next = await this.completeTask(group, task.id);
    this.deps.progress?.(
      `group ${group.id} task ${task.id}: done in ${formatDuration(this.now() - startedAt)}`,
      this.stepFor(group.id, 'working', task),
    );
    return { kind: 'ok', group: next, delivery: result.delivery };
  }

  // Persist a stage transition and the coarse status it maps to. Transitions that follow an
  // external side effect (openPr at `pr-open`, mergePr into `merged`) are guarded so a failed
  // write can't roll a landed PR/merge back to blocked.
  private async persistStageAfter(from: GroupStage, to: GroupStage, ctx: StageCtx): Promise<void> {
    const write = () => this.markStatus(ctx.group.id, statusForStage(to), { stage: to });
    if (to === 'merged') {
      await this.persistAfterSideEffect(this.mergedOutcome(ctx), write);
      // A nothing-to-ship group reaches 'merged' with no PR and never pushed a branch worth removing.
      if (ctx.group.pr !== null) await this.discardMergedBranch(ctx.group.id, ctx.group.branch);
      return;
    }
    if (from === 'pr-open') {
      await this.persistAfterSideEffect(this.awaitingPrOutcome(ctx), write);
      return;
    }
    await write();
  }

  // Tidy the merged group's branch away, locally and on origin. Strictly after the state write: the
  // merge is already durable, so a git failure here is cosmetic and must never surface as a failed
  // group. A group that merged with no PR (nothing to ship) never pushed a branch worth removing.
  // Delete a group's branch once its PR has merged. `groupId`/`branch` are passed explicitly because
  // the two call sites hold the merged state differently — persistStageAfter has it on ctx.group,
  // openAndMaybeMerge (prPerTask) has only the just-opened pr — and neither can rely on the in-memory
  // group's `pr` field being current.
  private async discardMergedBranch(groupId: string, branch: string | null): Promise<void> {
    if (branch === null || !this.deps.home.discardBranch) return;
    try {
      const baseBranch = await this.deps.github.defaultBranch();
      const cleanup = await this.deps.home.discardBranch(branch, baseBranch);
      this.deps.progress?.(`group ${groupId}: ${branchCleanupMessage(branch, cleanup)}`);
    } catch {
      // best-effort tidy-up
    }
  }

  private mergedOutcome(ctx: StageCtx): GroupOutcome {
    return this.terminalOutcome(ctx, 'merged');
  }

  private awaitingPrOutcome(ctx: StageCtx): GroupOutcome {
    return this.terminalOutcome(ctx, 'awaiting-pr');
  }

  // Terminal outcome for a group whose PR is open. `physical` is what actually happened to that PR —
  // 'merged' (autoMerge drove it home) or 'awaiting-pr' (autoMerge off, or a crash right after
  // pr-open). If work() dropped a task this pass (ctx.dropped) — an earlier task committed, a later
  // one blocked — the PR shipped the committed work but the group isn't fully done: downgrade to
  // 'partial' so the run reflects the dropped task rather than counting a not-fully-done group as a
  // clean merge/awaiting-pr. Keyed on ctx.dropped (an active this-pass drop), NOT the raw task-done
  // flags, so a resume that re-enters past 'working' — its tasks already finished upstream — keeps
  // its clean terminal. prNumberOf is safe — every terminal path reaches here with an open PR.
  private terminalOutcome(ctx: StageCtx, physical: 'merged' | 'awaiting-pr'): GroupOutcome {
    // A nothing-to-ship group reaches 'merged' with no PR (handlePrOpen's null path): every task
    // completed but the branch added no commits over the base. The only PR-less terminal.
    if (ctx.group.pr === null) {
      return { groupId: ctx.group.id, status: 'merged', pr: null };
    }
    const pr = prNumberOf(ctx.group);
    if (ctx.dropped.length > 0) {
      return { groupId: ctx.group.id, status: 'partial', pr, dropped: ctx.dropped };
    }
    return { groupId: ctx.group.id, status: physical, pr };
  }

  // Run the pre-PR self-review pass at the single choke point before every openPr (stage machine +
  // prPerTask). Default-on: skipped only when the run disables it (`selfReview: false`) or the
  // orchestrator port doesn't wire it. Best-effort and NON-fatal — it commits any fixes onto the
  // group branch, but a review that can't fully clean the diff (or that throws) never blocks the
  // group: the PR still opens, with external CI as the backstop. The outcome is surfaced as one
  // progress line so the operator sees whether the diff was clean, fixed, or shipped still-unclean.
  private async maybeSelfReview(
    group: PrGroup,
    delivery: WorkerDelivery,
    checkout: Checkout,
    baseBranch: string,
  ): Promise<void> {
    if (this.deps.selfReview === false) return;
    const run = this.deps.orchestrator.selfReview;
    if (!run) return;
    const step = this.stepFor(group.id, 'self-review');
    try {
      const result = await run({ group, delivery, checkout, baseBranch });
      this.deps.progress?.(selfReviewProgress(group.id, result), step);
    } catch (err) {
      // A crash in the safety net must never strand the committed work or gate the PR.
      const reason = describeError(err).message;
      this.deps.progress?.(
        `group ${group.id}: self-review errored (${reason}) — opening PR anyway`,
        step,
      );
    }
  }

  // Mark one task complete: flip its `done` flag in persisted state (preserving the group's
  // current status/branch/pr), re-render plan.md so the on-disk checkbox state matches, and
  // return the group with the task marked done for the rest of this pass.
  private async completeTask(group: PrGroup, taskId: string): Promise<PrGroup> {
    const next = await this.deps.state.update((s) => ({
      ...s,
      prGroups: s.prGroups.map((g) =>
        g.id === group.id
          ? { ...g, tasks: g.tasks.map((t) => (t.id === taskId ? { ...t, done: true } : t)) }
          : g,
      ),
    }));
    await this.renderPlan(next.prGroups);
    return {
      ...group,
      tasks: group.tasks.map((t) => (t.id === taskId ? { ...t, done: true } : t)),
    };
  }

  // Persist the current PR groups so plan.md's checkboxes ([ ] / [x]) reflect per-task completion.
  // StateStore.writePlan renders the markdown. No-op when the state port omits writePlan (stubs).
  private async renderPlan(groups: readonly PrGroup[]): Promise<void> {
    await this.deps.state.writePlan?.(
      groups.map((g) => ({
        title: g.title,
        tasks: g.tasks.map((t) => ({ text: t.text, complexity: t.complexity, done: t.done })),
      })),
    );
  }

  // Run a state write that follows a successful external side effect. If the write throws,
  // wrap the error in StateWriteAfterSuccess so callers don't roll the outcome back.
  private async persistAfterSideEffect(
    outcome: GroupOutcome,
    write: () => Promise<void>,
  ): Promise<void> {
    try {
      await write();
    } catch (err) {
      throw new StateWriteAfterSuccess(outcome, err);
    }
  }

  private sessionCapReached(maxSessions: number | null): boolean {
    return maxSessions !== null && this.sessionCount >= maxSessions;
  }

  private nextBatchSize(
    readyCount: number,
    concurrency: number,
    maxSessions: number | null,
  ): number {
    const remaining =
      maxSessions !== null ? Math.max(0, maxSessions - this.sessionCount) : readyCount;
    return Math.min(concurrency, readyCount, remaining);
  }

  // Build the RunStep (phase + N/M counter) for a progress line. The phase always shows; the
  // counter is filled from the injected resolver when present (production), omitted otherwise (stubs).
  private stepFor(groupId: string, phase: string, task?: Task): RunStep {
    const counter = this.deps.stepCounter?.(groupId, task);
    return counter ? { phase, ...counter } : { phase };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // Elapsed time since `runGroup` started this group, formatted for a `merged` progress line.
  // Missing start (unreachable in normal flow — runGroup always seeds it before any merge point)
  // falls back to `0.0s` rather than throwing, so a timing line can never break the run.
  private groupElapsedLabel(groupId: string): string {
    const startedAt = this.groupStartedAt.get(groupId);
    return formatDuration(startedAt === undefined ? 0 : this.now() - startedAt);
  }

  private async markStatus(
    id: string,
    status: PrGroup['status'],
    patch: Partial<
      Pick<PrGroup, 'branch' | 'pr' | 'prUrl' | 'stage' | 'ciFixAttempts' | 'humanNeeded'>
    > = {},
  ): Promise<void> {
    // Status transitions do not bump sessionCount — that's owned by incrementSessionCount,
    // which fires once per started group so the in-memory and persisted counters agree.
    await this.deps.state.update((s) => ({
      ...s,
      prGroups: s.prGroups.map((g) => (g.id === id ? { ...g, ...patch, status } : g)),
    }));
  }

  // Charge one session as a group starts: bump both the in-memory counter (run() reads it to
  // enforce maxSessions) and the persisted counter (reporting/resume) in one call. Called once per
  // started group — never once per batch — so the persisted count never exceeds groups that
  // actually started and a resume can't inherit an inflated count. Rolls the in-memory bump back if
  // persistence fails so the two stay aligned.
  private async incrementSessionCount(): Promise<void> {
    this.sessionCount += 1;
    try {
      await this.deps.state.update((s) => ({ ...s, sessionCount: s.sessionCount + 1 }));
    } catch (err) {
      this.sessionCount -= 1;
      throw err;
    }
  }

  private finalResult(): WorkLoopResult {
    const blocked = this.outcomes.find(
      (o): o is GroupOutcome & { status: 'blocked' } => o.status === 'blocked',
    );
    if (blocked) {
      return {
        kind: 'blocked',
        reason: `group ${blocked.groupId} blocked: ${blocked.reason}`,
        outcomes: this.outcomes.slice(),
      };
    }
    const partials = this.outcomes.filter(
      (o): o is GroupOutcome & { status: 'partial' } => o.status === 'partial',
    );
    if (partials.length > 0) {
      // A group shipped a PR for its committed tasks but blocked on a later one. The landed work is
      // NOT rolled back, yet the run must be non-success: the dropped task(s) are never
      // auto-rescheduled (a shipped group leaves PlanGraph.ready()), so exiting 0 would hide lost
      // work. Surface as blocked so the operator adds a follow-up for the undone task(s).
      const detail = partials
        .map((p) => `group ${p.groupId} (PR #${p.pr}) left task(s) ${p.dropped.join(', ')} undone`)
        .join('; ');
      return {
        kind: 'blocked',
        reason: `partial delivery — ${detail}; the dropped task(s) are not auto-rescheduled and need a follow-up`,
        outcomes: this.outcomes.slice(),
      };
    }
    const awaitingPrs = this.outcomes
      .filter((o): o is GroupOutcome & { status: 'awaiting-pr' } => o.status === 'awaiting-pr')
      .map((o) => o.pr);
    if (awaitingPrs.length > 0) {
      // autoMerge off: the PRs are deliberately left open for `aitm merge-pr` — a clean terminal
      // (exit 0). Under autoMerge an awaiting-pr outcome is instead a DANGLING PR: openPr landed but
      // the group never reached 'merged' (a StateWriteAfterSuccess at pr-open). Reporting 'success'
      // there would exit 0 while a PR sits unmerged; surface it as non-success so a resume/human
      // finishes the merge (the idempotent open adopts the PR on the next `aitm start`).
      if (this.deps.autoMerge) {
        return {
          kind: 'blocked',
          reason: `PR(s) ${awaitingPrs.join(', ')} opened but not merged under auto-merge (interrupted after PR open) — rerun \`aitm start\` to resume the merge`,
          outcomes: this.outcomes.slice(),
        };
      }
      return { kind: 'awaiting-pr', prs: awaitingPrs, outcomes: this.outcomes.slice() };
    }
    return { kind: 'success', outcomes: this.outcomes.slice() };
  }
}

// Where a group re-enters the stage machine: a persisted mid-lifecycle stage resumes there;
// a fresh or `pending` group (and legacy state without a stage) starts at 'working'.
function resumeStage(group: PrGroup): GroupStage {
  const stage: GroupStage | undefined = group.stage;
  return stage === undefined || stage === 'pending' ? 'working' : stage;
}

// Stage → handler dispatch (the dispatcher's switch). 'pending' is treated as 'working' since the
// dispatcher normalizes it on entry; the terminal stages ('merged'/'blocked') have no handler.
function handlerFor(stage: Exclude<GroupStage, 'merged' | 'blocked'>): StageHandler {
  switch (stage) {
    case 'pending':
    case 'working':
      return handleWorking;
    case 'pr-open':
      return handlePrOpen;
    case 'waiting-ci':
      return handleWaitingCi;
    case 'ci-failed':
      return handleCiFailed;
    case 'waiting-reviews':
      return handleWaitingReviews;
    case 'addressing-reviews':
      return handleAddressingReviews;
    case 'ready-to-merge':
      return handleReadyToMerge;
  }
}

// Coarse PrGroup.status for a given stage, kept for reporting/PlanGraph alongside the finer stage.
function statusForStage(stage: GroupStage): PrGroupStatus {
  switch (stage) {
    case 'pending':
      return 'pending';
    case 'working':
    case 'pr-open':
      return 'in-progress';
    case 'merged':
      return 'merged';
    case 'blocked':
      return 'blocked';
    default:
      // waiting-ci, ci-failed, waiting-reviews, addressing-reviews, ready-to-merge — PR is open.
      return 'awaiting-pr';
  }
}

// Human reason a stage handler yielded 'blocked'. A block at ci-failed/addressing-reviews means the
// automated recovery itself couldn't finish — the fix didn't go green / hit a rebase conflict, or
// the Reviewer errored — so the PR needs a human. This is the LAST-RESORT fallback: a handler that
// knows the specific reason (which checks failed, an unresolvable conflict) pairs it with its
// 'blocked' return and the dispatcher prefers it, so this generic wording only fires when no
// specific reason was carried. It deliberately does NOT assert a rebase conflict — that's only one
// possible cause and claiming one when CI is merely still red is misleading.
function blockReasonFor(stage: GroupStage, group: PrGroup): string {
  switch (stage) {
    case 'ci-failed':
      return `CI fix could not land for PR #${group.pr ?? '?'} — open the PR to see which checks still fail`;
    case 'addressing-reviews':
      return `could not address review threads on PR #${group.pr ?? '?'} (reviewer error or failed push)`;
    default:
      return `group ${group.id} blocked at stage '${stage}'`;
  }
}

function prNumberOf(group: PrGroup): number {
  if (group.pr === null) {
    throw new Error(`group ${group.id} has no PR number`);
  }
  return group.pr;
}

// One progress line summarizing the pre-PR self-review outcome. `unclean` and `error` both carry a
// reason — `unclean` is a red diff shipped anyway, `error` is a review that never completed (it must
// not read as clean); the others just note clean vs. fixed.
function selfReviewProgress(groupId: string, result: SelfReviewResult): string {
  switch (result.kind) {
    case 'clean':
      return `group ${groupId}: self-review clean — opening PR`;
    case 'reviewed':
      return `group ${groupId}: self-review applied fixes — opening PR`;
    case 'error':
      return `group ${groupId}: self-review errored (${result.reason}) — opening PR anyway (external CI is the backstop)`;
    default:
      return `group ${groupId}: self-review could not fully clean the diff (${result.reason}) — opening PR anyway (external CI is the backstop)`;
  }
}

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

import { CiFailed } from '../github/errors.ts';
import type { CiResult, MergeMethod, Sleep } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import { phaseForStage, type StepCounterFn } from '../observability/run-step.ts';
import { formatDuration, type RunStep } from '../observability/step-progress.ts';
import type { PlanMarkdownGroup } from '../plan/plan-markdown.ts';
import type { GroupStage, PrGroup, PrGroupStatus, RunState, Task } from '../state/schema.ts';
import type { FileChange, WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import { perTaskBranch } from '../workspace/branch-name.ts';
import type { Checkout } from '../workspace/in-place-checkout.ts';
import { DEFAULT_MAX_CI_FIX_ATTEMPTS } from './constants.ts';
import { Mutex } from './mutex.ts';
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
};

export type WorkLoopGithub = {
  defaultBranch(): Promise<string>;
  waitForChecks(pr: number): Promise<CiResult>;
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
  progress?: (message: string, step?: RunStep) => void;
  // Resolve the N/M step counter for a group/task, injected by the adapter (it owns the plan totals
  // + prPerTask). Optional — omitted → the phase word still shows, without a counter.
  stepCounter?: StepCounterFn;
  // Abort handle threaded from the CLI's SIGINT/SIGTERM handler (cli.ts → RunLoopInput.signal →
  // run-loop-adapter.ts). Checked at each loop iteration boundary so a cancelled run reports
  // `{ kind: 'cancelled' }` (exit 2) instead of surfacing whatever abort-induced group failure
  // `runGroup`'s catch produced as `blocked` (exit 1). Optional — omitted → no cancellation check,
  // byte-identical to pre-signal behavior. See docs/plans/.../02-signal-cancellation-cleanup.md.
  signal?: AbortSignal;
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

// Reduce a caught value to display text the way every catch site in this file already did
// (`err instanceof Error ? err.message : String(err)`), but without silently dropping the
// original value: wrapping a non-Error in a real Error keeps it reachable as `.cause` instead of
// discarding it once `String(err)` runs. A caught Error is returned as-is — same object, same
// `.message`, whatever `.cause` it already carried. Exported for the cause-preservation unit test.
export function describeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err), { cause: err });
}

// The two Errors autoMergeFlow throws when a recovery session reports 'blocked' — pulled out as
// named, pure functions (same message text as before) so `{cause}` is unit-testable without
// wiring the whole stage machine, and so the StageWorkResult that explains WHY it blocked isn't
// discarded at the throw the way a bare `${fix.reason}` interpolation would.
export function ciFixFailedError(fix: Extract<StageWorkResult, { kind: 'blocked' }>): Error {
  return new Error(`worker CI fix failed: ${fix.reason}`, { cause: fix });
}

export function reviewFailedError(review: Extract<StageWorkResult, { kind: 'blocked' }>): Error {
  return new Error(`reviewer failed: ${review.reason}`, { cause: review });
}

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
    const { graph, maxSessions, concurrency, signal } = this.deps;

    while (!graph.isComplete()) {
      if (signal?.aborted) {
        return { kind: 'cancelled', outcomes: this.outcomes.slice() };
      }
      if (this.sessionCapReached(maxSessions)) {
        return { kind: 'session-cap', outcomes: this.outcomes.slice() };
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
      // Re-check post-batch: an abort mid-batch aborts each group's in-flight LLM calls
      // (worker.ts signal wiring), which runGroup's catch would otherwise report as `blocked`
      // (exit 1). A cancelled run must report cancelled (exit 2) regardless of the abort-induced
      // per-group outcome.
      if (signal?.aborted) {
        return { kind: 'cancelled', outcomes: this.outcomes.slice() };
      }
    }

    return this.finalResult();
  }

  // Run a single group. The group-as-PR default drives the PR lifecycle through the persisted
  // stage machine (driveStages); prPerTask opens — and under autoMerge merges — a PR per task
  // (processGroup). Both acquire a checkout, persist an in-progress entry, and release on exit.
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
          await this.processGroup({ ...group, branch }, checkout, baseBranch);
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
        // best-effort release if processGroup itself threw before the inner finally ran;
        // the inner finally would have run already in normal flow, so this is defensive.
        try {
          await this.deps.home.release(group.id);
        } catch {
          /* swallow */
        }
      }
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
    }
  }

  // prPerTask mode: each not-yet-done task is one Worker pass → commit → mark done → persist,
  // then opens — and under autoMerge merges — its own PR. Resumed tasks already `done` are
  // skipped. The group-as-PR default runs through driveStages instead.
  //
  // Base-fresh per task: under autoMerge each task's PR merges before the next task runs, so the next
  // task must start from the freshly-merged base. Otherwise, with the default squash merge, task N's
  // original branch commit is not an ancestor of the base's new squash commit, and task N+1's PR —
  // opened from the same branch — re-includes task N's changes (each successive PR grows). So under
  // autoMerge every task gets its OWN branch reset off origin/<base> via home.resetToBase, mirroring
  // claudetm's fresh `git checkout -b` per task. Without autoMerge there is no merged base to branch
  // from mid-group, and a home without resetToBase (test stubs) can't reset either — both fall back to
  // the single group branch, opening a PR per task off it.
  private async processGroup(
    group: PrGroup,
    checkout: Checkout,
    baseBranch: string,
  ): Promise<void> {
    let remaining = group.tasks.filter((t) => !t.done).length;
    if (remaining === 0) {
      // Every task was already done on entry — a resumed group whose work finished in a prior
      // run but which never opened a PR. There's no fresh delivery to compose one from, so
      // surface it as blocked rather than fabricating an empty PR.
      await this.markStatus(group.id, 'blocked');
      this.outcomes.push({
        groupId: group.id,
        status: 'blocked',
        reason: 'all tasks already complete but no pull request was opened',
      });
      return;
    }

    // Keep the home reference and call resetToBase AS A METHOD — extracting it to a bare local
    // (`const fn = home.resetToBase`) drops the `this` binding, and the real InPlaceCheckout reads
    // `this.current`, so a detached call throws "undefined is not an object".
    const home = this.deps.home;
    const canResetToBase = this.deps.autoMerge && typeof home.resetToBase === 'function';
    const groupBranch = group.branch ?? `aitm/${group.id}`;
    let worked = group;
    let co = checkout;
    for (const task of group.tasks) {
      if (task.done) continue;
      if (canResetToBase && home.resetToBase) {
        // Fresh branch off the merged base for this task's isolated PR (see method doc).
        const branch = perTaskBranch(groupBranch, task.id);
        co = await home.resetToBase(group.id, branch, baseBranch);
        worked = { ...worked, branch };
      }
      const result = await this.runOneTask(worked, task, co, baseBranch);
      if (result.kind === 'blocked') {
        // Surface the reason live — this prPerTask task-blocked path otherwise marks the group
        // blocked SILENTLY (no progress line), so a failed task looks like the group just vanished.
        this.deps.progress?.(
          `group ${group.id} task ${task.id}: → blocked (${result.reason})`,
          this.stepFor(group.id, 'blocked', task),
        );
        await this.markStatus(group.id, 'blocked');
        this.outcomes.push({ groupId: group.id, status: 'blocked', reason: result.reason });
        return;
      }
      worked = result.group;
      remaining -= 1;
      // Only the last task may mark the group terminal. Marking the whole group awaiting-pr/merged
      // after an earlier task's PR would strand the still-undone tasks: a crash there leaves a
      // terminal group PlanGraph.ready() won't reschedule. While tasks remain, the group stays
      // in-progress (schedulable on resume).
      await this.openAndMaybeMerge(worked, result.delivery, co, baseBranch, remaining === 0);
    }
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

      // Cap the CI-fix recovery loop: count each ci-failed dispatch against a budget that now
      // survives resumes (see StageCtx.fixAttempts), and once the cap is exceeded block WITHOUT
      // running the fix session (no LLM call, no push) so an unfixable red PR ends for a human
      // instead of cycling forever — across resumes as well as within one run (issue #128).
      if (stage === 'ci-failed') {
        // Charge one durable fix-attempt slot BEFORE dispatching the fix, so a crash mid-fix can't
        // hand the resumed run a fresh budget — the count is consumed at dispatch and persisted.
        ctx.fixAttempts += 1;
        ctx.group = { ...ctx.group, ciFixAttempts: ctx.fixAttempts };
        if (ctx.fixAttempts > this.maxCiFixAttempts) {
          ctx.blockedReason = `CI fix attempts exhausted after ${this.maxCiFixAttempts} passes for PR #${prNumberOf(ctx.group)} — needs human attention`;
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
        this.deps.progress?.(
          `group ${ctx.group.id}: ${stage} → ${next}${reason}${timing}`,
          this.stepFor(ctx.group.id, phaseForStage(next)),
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
        ctx.group = { ...ctx.group, pr: opened.number };
        return opened.number;
      },
      fixCi: (group) =>
        this.deps.orchestrator.runCiFix({ group, pr: prNumberOf(group), checkout, baseBranch }),
      addressReviews: (group, threads) =>
        this.deps.orchestrator.addressReviews({ pr: prNumberOf(group), threads, checkout }),
    };
    const authenticatedLogin = this.deps.github.authenticatedLogin?.bind(this.deps.github);
    const github: StageGithub = {
      waitForChecks: (pr) => this.deps.github.waitForChecks(pr),
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
  ): Promise<
    { kind: 'ok'; group: PrGroup; delivery: WorkerDelivery } | { kind: 'blocked'; reason: string }
  > {
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
      const worked = await this.deps.orchestrator.runWorker({ group, task, checkout, baseBranch });
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
      return;
    }
    if (from === 'pr-open') {
      await this.persistAfterSideEffect(this.awaitingPrOutcome(ctx), write);
      return;
    }
    await write();
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

  // Open the PR for one delivery, persist the outcome, and — under autoMerge — run the CI/review/
  // merge flow. Invoked once per task in `prPerTask` mode. `final` is true only for the last
  // undone task: until then the group's persisted status stays 'in-progress' (schedulable) so a
  // crash between per-task PRs leaves the remaining tasks runnable on resume. External side effects
  // (openPr/mergePr) are guarded by StateWriteAfterSuccess so a failed state write never rolls a
  // landed PR back to 'blocked'.
  private async openAndMaybeMerge(
    group: PrGroup,
    delivery: WorkerDelivery,
    checkout: Checkout,
    baseBranch: string,
    final: boolean,
  ): Promise<void> {
    await this.maybeSelfReview(group, delivery, checkout, baseBranch);
    const opened = await this.deps.orchestrator.openPr(group, delivery, baseBranch);
    if (opened === 'nothing-to-ship') {
      // The task completed without adding commits (a declared no-changes task) — no PR to open or
      // merge. Only the final task may mark the group terminal (same rule as the PR path below);
      // its terminal must not overwrite what earlier tasks' PRs established: with an earlier PR
      // still awaiting merge the group stays awaiting-pr, and a fresh merged outcome is pushed only
      // when no earlier task recorded one (an all-no-changes group).
      if (final) {
        const prior = this.outcomes.filter((o) => o.groupId === group.id);
        const awaiting = prior.some((o) => o.status === 'awaiting-pr');
        await this.markStatus(group.id, awaiting ? 'awaiting-pr' : 'merged');
        if (prior.length === 0) {
          this.outcomes.push({ groupId: group.id, status: 'merged', pr: null });
        }
        this.deps.progress?.(
          `group ${group.id}: done — nothing to ship for the final task (${this.groupElapsedLabel(group.id)})`,
          this.stepFor(group.id, 'merged'),
        );
      }
      return;
    }
    const pr = opened;
    await this.persistAfterSideEffect(
      { groupId: group.id, status: 'awaiting-pr', pr: pr.number },
      () => this.markStatus(group.id, final ? 'awaiting-pr' : 'in-progress', { pr: pr.number }),
    );

    if (!this.deps.autoMerge) {
      this.outcomes.push({ groupId: group.id, status: 'awaiting-pr', pr: pr.number });
      return;
    }

    await this.autoMergeFlow(group, pr, checkout, baseBranch);
    await this.persistAfterSideEffect({ groupId: group.id, status: 'merged', pr: pr.number }, () =>
      this.markStatus(group.id, final ? 'merged' : 'in-progress'),
    );
    this.outcomes.push({ groupId: group.id, status: 'merged', pr: pr.number });
    if (final) {
      this.deps.progress?.(
        `group ${group.id}: merged — done in ${this.groupElapsedLabel(group.id)}`,
        this.stepFor(group.id, 'merged'),
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

  private async autoMergeFlow(
    group: PrGroup,
    pr: PullRequest,
    checkout: Checkout,
    baseBranch: string,
  ): Promise<void> {
    const { orchestrator, github } = this.deps;

    // CI: wait for checks. On failure, run the shared fix session (Worker → rebase onto
    // origin/<base> → force-with-lease push) so the fix reaches the remote BEFORE the recheck
    // re-polls; without the push the recheck would poll stale CI and the merge would land the
    // unfixed remote. runCiFix pushes; the old runWorker + finalizeCommit `--amend` only rewrote
    // history locally, diverging from the pushed branch. A poll timeout (CiFailed) propagates; a
    // fix that can't land, or still-red CI after it, is fatal for this flow.
    const ci = await github.waitForChecks(pr.number);
    if (ci.state === 'failure') {
      const fix = await orchestrator.runCiFix({ group, pr: pr.number, checkout, baseBranch });
      if (fix.kind !== 'ok') {
        throw ciFixFailedError(fix);
      }
      const recheck = await github.waitForChecks(pr.number);
      if (recheck.state === 'failure') {
        throw new CiFailed(`PR #${pr.number} still failing after worker CI fix`);
      }
    }

    // Review: address any unresolved threads via the Reviewer. addressReviews pushes the Reviewer's
    // code fixes to the remote, so the merge below lands them; runReviewer alone would leave them
    // committed only locally and merge without them.
    const threads = await github.listUnresolvedThreads(pr.number);
    if (threads.length > 0) {
      const review = await orchestrator.addressReviews({ pr: pr.number, threads, checkout });
      if (review.kind !== 'ok') {
        throw reviewFailedError(review);
      }
    }

    await github.mergePr(pr.number, this.deps.mergeMethod ?? DEFAULT_MERGE_METHOD, {
      admin: this.deps.adminMerge ?? false,
    });
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
    patch: Partial<Pick<PrGroup, 'branch' | 'pr' | 'stage' | 'ciFixAttempts' | 'humanNeeded'>> = {},
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

// One progress line summarizing the pre-PR self-review outcome. `unclean` is the only case that
// carries a reason (a red diff shipped to the PR anyway) — the others just note clean vs. fixed.
function selfReviewProgress(groupId: string, result: SelfReviewResult): string {
  switch (result.kind) {
    case 'clean':
      return `group ${groupId}: self-review clean — opening PR`;
    case 'reviewed':
      return `group ${groupId}: self-review applied fixes — opening PR`;
    default:
      return `group ${groupId}: self-review could not fully clean the diff (${result.reason}) — opening PR anyway (external CI is the backstop)`;
  }
}

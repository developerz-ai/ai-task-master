// docs/architecture.md (WorkLoop row), docs/commands/start.md §Flow
// Drives the Orchestrator group-by-group. Extended for concurrent execution:
//
//   while !plan.isComplete():
//     ready = planGraph.ready()
//     batch = ready.slice(0, free worker slots)
//     await Promise.all(batch.map(g => runGroup(g)))
//
// Each runGroup acquires a WorktreePool slot, runs Worker, and on PR open hands off to
// the merge-pr flow (CI wait + Reviewer + GitHubClient.mergePr).
//
// Deps are structural ports — concrete classes (Orchestrator, GitHubClient, StateStore,
// WorktreePool, PlanGraph) satisfy them at runtime; tests pass literal stubs.

import { CiFailed } from '../github/errors.ts';
import type { CiResult, MergeMethod } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import type { PlanMarkdownGroup } from '../plan/plan-markdown.ts';
import type { GroupStage, PrGroup, PrGroupStatus, RunState, Task } from '../state/schema.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { FileChange, WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import type { Worktree } from '../workspace/worktree-pool.ts';
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
  // The specific task being worked this pass. Omitted by the CI-fix invocation in autoMergeFlow,
  // which re-runs the Worker over the whole group rather than a single task.
  task?: Task;
  worktree: Worktree;
  baseBranch: string;
};

export type ReviewerInvocation = {
  pr: number;
  threads: ReviewThread[];
  worktree: Worktree;
};

export type CiFixInvocation = {
  group: PrGroup;
  pr: number;
  worktree: Worktree;
  baseBranch: string;
};

export type WorkLoopOrchestrator = {
  runWorker(input: WorkerInvocation): Promise<WorkerResult>;
  finalizeCommit(group: PrGroup, delivery: WorkerDelivery, worktreePath: string): Promise<string>;
  openPr(group: PrGroup, delivery: WorkerDelivery, baseBranch: string): Promise<PullRequest>;
  runReviewer(input: ReviewerInvocation): Promise<ReviewerResult>;
  // ci-failed stage: download failed logs + comments, run the Worker fix, rebase onto
  // origin/<base> and force-with-lease push. ok → CI re-runs; blocked → couldn't land the fix.
  runCiFix(input: CiFixInvocation): Promise<StageWorkResult>;
  // addressing-reviews stage: run the Reviewer over the given threads and push its code fixes.
  addressReviews(input: ReviewerInvocation): Promise<StageWorkResult>;
};

export type WorkLoopGithub = {
  defaultBranch(): Promise<string>;
  waitForChecks(pr: number): Promise<CiResult>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number, method: MergeMethod): Promise<void>;
};

export type WorkLoopPool = {
  acquire(groupId: string, branch: string, baseBranch: string): Promise<Worktree>;
  release(groupId: string): Promise<void>;
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
  pool: WorkLoopPool;
  graph: WorkLoopGraph;
  // Drives the addressing-reviews dedup. Optional — without it the review loop still terminates
  // once threads are resolved, but a replied-but-unresolved thread would be re-handled each poll.
  prContext?: WorkLoopPrContext;
  concurrency: number;
  autoMerge: boolean;
  // When true, open (and, under autoMerge, merge) a PR after each task. Default (false/omitted)
  // is aitm's group-as-PR mode: a single PR per group, opened after the final task lands.
  prPerTask?: boolean;
  maxSessions: number | null;
  mergeMethod?: MergeMethod;
  // Seed for resume: when WorkLoop is constructed after a previous run, pass
  // RunState.sessionCount so the in-memory counter and the persisted counter agree.
  initialSessionCount?: number;
};

export type GroupOutcome =
  | { groupId: string; status: 'merged'; pr: number }
  | { groupId: string; status: 'awaiting-pr'; pr: number }
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
// commits persist on the branch the WorktreePool reuses on resume — but no PR was opened and this
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

// Mutable scratch the stage dispatcher threads through one group-run. `group` is the authoritative
// in-memory copy the bridges keep current (tasks marked done by work(), pr set by openPr()); the
// persisted GroupStage is the dispatcher's job. `delivery` is the merged Worker delivery work()
// produced (every task's changes), consumed by openPr(). `blockedReason` carries the human reason a
// handler yielded 'blocked' (lost otherwise, since handlers return only the next stage).
type StageCtx = {
  group: PrGroup;
  delivery: WorkerDelivery | null;
  blockedReason: string | undefined;
};

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

  constructor(private readonly deps: WorkLoopDeps) {
    this.sessionCount = deps.initialSessionCount ?? 0;
  }

  async run(): Promise<WorkLoopResult> {
    const { graph, maxSessions, concurrency } = this.deps;

    while (!graph.isComplete()) {
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
      await this.incrementSessionCount(batch.length);
      await Promise.all(batch.map((g) => this.runGroup(g)));
    }

    return this.finalResult();
  }

  // Run a single group. The group-as-PR default drives the PR lifecycle through the persisted
  // stage machine (driveStages); prPerTask opens — and under autoMerge merges — a PR per task
  // (processGroup). Both acquire a worktree, persist an in-progress entry, and release on exit.
  async runGroup(group: PrGroup): Promise<void> {
    const branch = group.branch ?? `aitm/${group.id}`;
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
      const worktree = await this.deps.pool.acquire(group.id, branch, baseBranch);
      acquired = true;
      try {
        if (this.deps.prPerTask) {
          await this.processGroup({ ...group, branch }, worktree, baseBranch);
        } else {
          const outcome = await this.driveStages(
            { ...group, branch, stage: startStage },
            worktree,
            baseBranch,
          );
          this.outcomes.push(outcome);
        }
      } finally {
        await this.deps.pool.release(group.id);
        acquired = false;
      }
    } catch (err) {
      if (acquired) {
        // best-effort release if processGroup itself threw before the inner finally ran;
        // the inner finally would have run already in normal flow, so this is defensive.
        try {
          await this.deps.pool.release(group.id);
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
      const reason = err instanceof Error ? err.message : String(err);
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
  private async processGroup(
    group: PrGroup,
    worktree: Worktree,
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

    let worked = group;
    for (const task of group.tasks) {
      if (task.done) continue;
      const result = await this.runOneTask(worked, task, worktree, baseBranch);
      if (result.kind === 'blocked') {
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
      await this.openAndMaybeMerge(worked, result.delivery, worktree, baseBranch, remaining === 0);
    }
  }

  // Stage dispatcher — claudetm's `_run_workflow_cycle` (core/orchestrator.py). Advance one
  // transition per iteration off the persisted GroupStage, persisting after each, until a
  // terminal stage (`merged`/`blocked`) or — when autoMerge is off — until the PR is open
  // (`waiting-ci`), where it hands off to the merge-pr flow. On resume the group re-enters at
  // its persisted stage, so prior stages (working, pr-open) are never redone.
  private async driveStages(
    group: PrGroup,
    worktree: Worktree,
    baseBranch: string,
  ): Promise<GroupOutcome> {
    const ctx: StageCtx = { group, delivery: null, blockedReason: undefined };
    const deps = this.buildStageDeps(ctx, worktree, baseBranch);
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

      const handler = handlerFor(stage);
      const prBefore = ctx.group.pr;
      let next: GroupStage;
      try {
        next = await handler(deps, ctx.group);
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
      ctx.group = { ...ctx.group, stage: next };
      await this.persistStageAfter(stage, next, ctx);
      stage = next;
    }
  }

  // Bridge the WorkLoop's ports to the narrow surfaces the stage handlers drive. The handlers
  // stay worktree-agnostic; this closure owns the worktree, base branch and the per-run StageCtx.
  private buildStageDeps(ctx: StageCtx, worktree: Worktree, baseBranch: string): StageDeps {
    const orchestrator: StageOrchestrator = {
      work: async () => {
        const result = await this.workTasks(ctx.group, worktree, baseBranch);
        if (result.kind === 'blocked') {
          // A task couldn't complete this pass and nothing was committed this pass. If a prior run
          // already committed earlier tasks on the (reused) branch, open a PR for that recovered
          // work instead of stranding it; only block when there is genuinely nothing committed.
          const recovered = recoveredDelivery(ctx.group);
          if (recovered) {
            ctx.delivery = recovered;
            return { kind: 'ok' };
          }
          ctx.blockedReason = result.reason;
          return result;
        }
        ctx.group = result.group;
        ctx.delivery = result.delivery;
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
        const pr = await this.deps.orchestrator.openPr(ctx.group, ctx.delivery, baseBranch);
        ctx.group = { ...ctx.group, pr: pr.number };
        return pr.number;
      },
      fixCi: (group) =>
        this.deps.orchestrator.runCiFix({ group, pr: prNumberOf(group), worktree, baseBranch }),
      addressReviews: (group, threads) =>
        this.deps.orchestrator.addressReviews({ pr: prNumberOf(group), threads, worktree }),
    };
    const github: StageGithub = {
      waitForChecks: (pr) => this.deps.github.waitForChecks(pr),
      listUnresolvedThreads: (pr) => this.deps.github.listUnresolvedThreads(pr),
      mergePr: (pr) => this.deps.github.mergePr(pr, this.deps.mergeMethod ?? DEFAULT_MERGE_METHOD),
    };
    return {
      orchestrator,
      github,
      state: this.deps.state,
      ...(this.deps.prContext ? { prContext: this.deps.prContext } : {}),
    };
  }

  // Run every not-yet-done task of the group to commits on its branch (no PR), returning a single
  // delivery — the merge of every task's delivery — for openPr, so the composed PR body reflects the
  // whole group's changes rather than only the last task's. Idempotent on resume: tasks already
  // `done` are skipped. If a task blocks after earlier tasks already committed this pass, the
  // committed work still opens a PR (the block is not propagated); blocking is reserved for when
  // nothing has been committed.
  private async workTasks(
    group: PrGroup,
    worktree: Worktree,
    baseBranch: string,
  ): Promise<
    | { kind: 'ok'; group: PrGroup; delivery: WorkerDelivery | null }
    | { kind: 'blocked'; reason: string }
  > {
    let worked = group;
    const deliveries: WorkerDelivery[] = [];
    for (const task of group.tasks) {
      if (task.done) continue;
      const result = await this.runOneTask(worked, task, worktree, baseBranch);
      if (result.kind === 'blocked') {
        // A task couldn't complete. If earlier tasks in this group already committed work on this
        // pass, don't discard it: open a PR for what landed instead of stranding those commits on
        // the branch with no PR. Block outright only when nothing has been committed yet.
        if (deliveries.length > 0) {
          return { kind: 'ok', group: worked, delivery: mergeDeliveries(deliveries) };
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
    };
  }

  // One task: Worker pass → finalize commit → mark done → persist → re-render plan.md.
  private async runOneTask(
    group: PrGroup,
    task: Task,
    worktree: Worktree,
    baseBranch: string,
  ): Promise<
    { kind: 'ok'; group: PrGroup; delivery: WorkerDelivery } | { kind: 'blocked'; reason: string }
  > {
    const result = await this.deps.orchestrator.runWorker({ group, task, worktree, baseBranch });
    if (result.kind !== 'ok') {
      return { kind: 'blocked', reason: result.kind === 'blocked' ? result.reason : result.error };
    }
    await this.deps.orchestrator.finalizeCommit(group, result.delivery, worktree.path);
    const next = await this.completeTask(group, task.id);
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
    return { groupId: ctx.group.id, status: 'merged', pr: prNumberOf(ctx.group) };
  }

  private awaitingPrOutcome(ctx: StageCtx): GroupOutcome {
    return { groupId: ctx.group.id, status: 'awaiting-pr', pr: prNumberOf(ctx.group) };
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
    worktree: Worktree,
    baseBranch: string,
    final: boolean,
  ): Promise<void> {
    const pr = await this.deps.orchestrator.openPr(group, delivery, baseBranch);
    await this.persistAfterSideEffect(
      { groupId: group.id, status: 'awaiting-pr', pr: pr.number },
      () => this.markStatus(group.id, final ? 'awaiting-pr' : 'in-progress', { pr: pr.number }),
    );

    if (!this.deps.autoMerge) {
      this.outcomes.push({ groupId: group.id, status: 'awaiting-pr', pr: pr.number });
      return;
    }

    await this.autoMergeFlow(group, pr, worktree, baseBranch);
    await this.persistAfterSideEffect({ groupId: group.id, status: 'merged', pr: pr.number }, () =>
      this.markStatus(group.id, final ? 'merged' : 'in-progress'),
    );
    this.outcomes.push({ groupId: group.id, status: 'merged', pr: pr.number });
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
    worktree: Worktree,
    baseBranch: string,
  ): Promise<void> {
    const { orchestrator, github } = this.deps;

    // CI: wait for checks. On failure, ask Worker to fix and re-check; a timeout (CiFailed)
    // propagates. Still-red after the fix is fatal for this flow.
    const ci = await github.waitForChecks(pr.number);
    if (ci.state === 'failure') {
      const fix = await orchestrator.runWorker({ group, worktree, baseBranch });
      if (fix.kind !== 'ok') {
        const reason = fix.kind === 'blocked' ? fix.reason : fix.error;
        throw new Error(`worker CI fix failed: ${reason}`);
      }
      await orchestrator.finalizeCommit(group, fix.delivery, worktree.path);
      const recheck = await github.waitForChecks(pr.number);
      if (recheck.state === 'failure') {
        throw new CiFailed(`PR #${pr.number} still failing after worker CI fix`);
      }
    }

    // Review: resolve any unresolved threads via Reviewer.
    const threads = await github.listUnresolvedThreads(pr.number);
    if (threads.length > 0) {
      const review = await orchestrator.runReviewer({ pr: pr.number, threads, worktree });
      if (review.kind !== 'ok') {
        const reason = review.kind === 'blocked' ? review.reason : review.error;
        throw new Error(`reviewer failed: ${reason}`);
      }
    }

    await github.mergePr(pr.number, this.deps.mergeMethod ?? DEFAULT_MERGE_METHOD);
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

  private async markStatus(
    id: string,
    status: PrGroup['status'],
    patch: Partial<Pick<PrGroup, 'branch' | 'pr' | 'stage'>> = {},
  ): Promise<void> {
    // Status transitions do not bump sessionCount — that's owned by incrementSessionCount,
    // which fires once per batch dispatch so the in-memory and persisted counters agree.
    await this.deps.state.update((s) => ({
      ...s,
      prGroups: s.prGroups.map((g) => (g.id === id ? { ...g, ...patch, status } : g)),
    }));
  }

  // Single source of truth for session counting: bump both the in-memory counter (used by
  // run() to enforce maxSessions) and the persisted counter (used by reporting/resume) in
  // one call. Drops in-memory if persistence fails so the two stay aligned.
  private async incrementSessionCount(by: number): Promise<void> {
    if (by <= 0) return;
    this.sessionCount += by;
    try {
      await this.deps.state.update((s) => ({ ...s, sessionCount: s.sessionCount + by }));
    } catch (err) {
      this.sessionCount -= by;
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
    if (!this.deps.autoMerge) {
      const prs = this.outcomes
        .filter((o): o is GroupOutcome & { status: 'awaiting-pr' } => o.status === 'awaiting-pr')
        .map((o) => o.pr);
      if (prs.length > 0) {
        return { kind: 'awaiting-pr', prs, outcomes: this.outcomes.slice() };
      }
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
// the Reviewer errored — so the PR needs a human.
function blockReasonFor(stage: GroupStage, group: PrGroup): string {
  switch (stage) {
    case 'ci-failed':
      return `CI fix could not land for PR #${group.pr ?? '?'} (still failing, or a rebase conflict needs manual resolution)`;
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

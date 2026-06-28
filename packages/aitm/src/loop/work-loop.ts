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
import type { MergeMethod } from '../github/github-client.ts';
import type { CheckStatus, PullRequest, ReviewThread } from '../github/schema.ts';
import { renderPlanMarkdown } from '../plan/plan-markdown.ts';
import type { PrGroup, RunState, Task } from '../state/schema.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import type { Worktree } from '../workspace/worktree-pool.ts';

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

export type WorkLoopOrchestrator = {
  runWorker(input: WorkerInvocation): Promise<WorkerResult>;
  finalizeCommit(group: PrGroup, delivery: WorkerDelivery, worktreePath: string): Promise<string>;
  openPr(group: PrGroup, delivery: WorkerDelivery, baseBranch: string): Promise<PullRequest>;
  runReviewer(input: ReviewerInvocation): Promise<ReviewerResult>;
};

export type WorkLoopGithub = {
  defaultBranch(): Promise<string>;
  waitForChecks(pr: number): Promise<CheckStatus>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number, method: MergeMethod): Promise<void>;
};

export type WorkLoopPool = {
  acquire(groupId: string, branch: string, baseBranch: string): Promise<Worktree>;
  release(groupId: string): Promise<void>;
};

export type WorkLoopState = {
  update(mutator: (s: RunState) => RunState): Promise<RunState>;
  // Re-render plan.md (checkbox markdown) after per-task completion. Optional: stubs that don't
  // care about the on-disk plan can omit it; production wires it to StateStore.writePlan.
  writePlan?(markdown: string): Promise<void>;
};

export type WorkLoopGraph = {
  ready(): PrGroup[];
  isComplete(): boolean;
};

export type WorkLoopDeps = {
  orchestrator: WorkLoopOrchestrator;
  github: WorkLoopGithub;
  state: WorkLoopState;
  pool: WorkLoopPool;
  graph: WorkLoopGraph;
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
  | { kind: 'session-cap'; outcomes: GroupOutcome[] };

const DEFAULT_MERGE_METHOD: MergeMethod = 'squash';

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

  // Run a single group end-to-end: worktree → Worker → (optionally) merge-pr inline.
  async runGroup(group: PrGroup): Promise<void> {
    const branch = group.branch ?? `aitm/${group.id}`;
    let acquired = false;
    try {
      const baseBranch = await this.deps.github.defaultBranch();
      await this.markStatus(group.id, 'in-progress', { branch });
      const worktree = await this.deps.pool.acquire(group.id, branch, baseBranch);
      acquired = true;
      try {
        await this.processGroup({ ...group, branch }, worktree, baseBranch);
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

  private async processGroup(
    group: PrGroup,
    worktree: Worktree,
    baseBranch: string,
  ): Promise<void> {
    const { orchestrator } = this.deps;
    const { tasks } = group;

    // Execute the group task-by-task. Each not-yet-done task is one Worker pass → commit → mark
    // done → persist → re-render plan.md. On resume, tasks already marked `done` in a prior run
    // are skipped so landed work is never redone. A PR opens after each task when `prPerTask` is
    // set, otherwise once after the final task (aitm's group-as-PR default). Because tasks are
    // completed in order, done tasks form a contiguous prefix, so the last array element is the
    // last task this pass processes.
    let worked = group;
    let opened = false;
    for (const [i, task] of tasks.entries()) {
      if (task.done) continue;
      const result = await orchestrator.runWorker({ group: worked, task, worktree, baseBranch });
      if (result.kind !== 'ok') {
        const reason = result.kind === 'blocked' ? result.reason : result.error;
        await this.markStatus(group.id, 'blocked');
        this.outcomes.push({ groupId: group.id, status: 'blocked', reason });
        return;
      }
      const delivery = result.delivery;
      await orchestrator.finalizeCommit(worked, delivery, worktree.path);
      worked = await this.completeTask(worked, task.id);

      if (this.deps.prPerTask || i === tasks.length - 1) {
        await this.openAndMaybeMerge(worked, delivery, worktree, baseBranch);
        opened = true;
      }
    }

    if (!opened) {
      // Every task was already done on entry — a resumed group whose work finished in a prior
      // run but which never opened a PR. There's no fresh delivery to compose one from, so
      // surface it as blocked rather than fabricating an empty PR.
      await this.markStatus(group.id, 'blocked');
      this.outcomes.push({
        groupId: group.id,
        status: 'blocked',
        reason: 'all tasks already complete but no pull request was opened',
      });
    }
  }

  // Open the PR for one delivery, persist the outcome, and — under autoMerge — run the CI/review/
  // merge flow. Invoked once per group (default) or once per task (`prPerTask`). External side
  // effects (openPr/mergePr) are guarded by StateWriteAfterSuccess so a failed state write never
  // rolls a landed PR back to 'blocked'.
  private async openAndMaybeMerge(
    group: PrGroup,
    delivery: WorkerDelivery,
    worktree: Worktree,
    baseBranch: string,
  ): Promise<void> {
    const pr = await this.deps.orchestrator.openPr(group, delivery, baseBranch);
    await this.persistAfterSideEffect(
      { groupId: group.id, status: 'awaiting-pr', pr: pr.number },
      () => this.markStatus(group.id, 'awaiting-pr', { pr: pr.number }),
    );

    if (!this.deps.autoMerge) {
      this.outcomes.push({ groupId: group.id, status: 'awaiting-pr', pr: pr.number });
      return;
    }

    await this.autoMergeFlow(group, pr, worktree, baseBranch);
    await this.persistAfterSideEffect({ groupId: group.id, status: 'merged', pr: pr.number }, () =>
      this.markStatus(group.id, 'merged'),
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

  // Re-render plan.md from the current PR groups so its checkboxes ([ ] / [x]) reflect per-task
  // completion. No-op when the state port doesn't expose writePlan (some unit-test stubs).
  private async renderPlan(groups: readonly PrGroup[]): Promise<void> {
    const markdown = renderPlanMarkdown(
      groups.map((g) => ({
        title: g.title,
        tasks: g.tasks.map((t) => ({ text: t.text, complexity: t.complexity, done: t.done })),
      })),
    );
    await this.deps.state.writePlan?.(markdown);
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

    // CI: wait for checks. On failure, ask Worker to fix and re-check.
    try {
      await github.waitForChecks(pr.number);
    } catch (err) {
      if (!(err instanceof CiFailed)) throw err;
      const fix = await orchestrator.runWorker({ group, worktree, baseBranch });
      if (fix.kind !== 'ok') {
        const reason = fix.kind === 'blocked' ? fix.reason : fix.error;
        throw new Error(`worker CI fix failed: ${reason}`);
      }
      await orchestrator.finalizeCommit(group, fix.delivery, worktree.path);
      await github.waitForChecks(pr.number);
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
    patch: Partial<Pick<PrGroup, 'branch' | 'pr'>> = {},
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

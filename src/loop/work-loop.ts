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
import type { PrGroup, RunState } from '../state/schema.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerResult } from '../subagents/worker.ts';
import type { Worktree } from '../workspace/worktree-pool.ts';

export type WorkerInvocation = {
  group: PrGroup;
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
  maxSessions: number | null;
  mergeMethod?: MergeMethod;
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

export class WorkLoop {
  private readonly outcomes: GroupOutcome[] = [];
  private sessionCount = 0;

  constructor(private readonly deps: WorkLoopDeps) {}

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
      this.sessionCount += batch.length;
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
    const workerResult = await orchestrator.runWorker({ group, worktree, baseBranch });
    if (workerResult.kind !== 'ok') {
      const reason = workerResult.kind === 'blocked' ? workerResult.reason : workerResult.error;
      await this.markStatus(group.id, 'blocked');
      this.outcomes.push({ groupId: group.id, status: 'blocked', reason });
      return;
    }
    const delivery = workerResult.delivery;
    await orchestrator.finalizeCommit(group, delivery, worktree.path);
    const pr = await orchestrator.openPr(group, delivery, baseBranch);
    await this.markStatus(group.id, 'awaiting-pr', { pr: pr.number });

    if (!this.deps.autoMerge) {
      this.outcomes.push({ groupId: group.id, status: 'awaiting-pr', pr: pr.number });
      return;
    }

    await this.autoMergeFlow(group, pr, worktree, baseBranch);
    await this.markStatus(group.id, 'merged');
    this.outcomes.push({ groupId: group.id, status: 'merged', pr: pr.number });
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
    await this.deps.state.update((s) => ({
      ...s,
      prGroups: s.prGroups.map((g) => (g.id === id ? { ...g, ...patch, status } : g)),
      sessionCount: s.sessionCount + 1,
    }));
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

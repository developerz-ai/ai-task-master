// prPerTask mode: aitm's per-task PR delivery, the twin of the group-as-PR stage machine
// (driveStages, work-loop.ts). Each not-yet-done task is one Worker pass → commit → mark done →
// persist, then opens — and under autoMerge merges — its own PR. Resumed tasks already `done` are
// skipped. WorkLoop.runGroup dispatches here when WorkLoopDeps.prPerTask is set; the group-as-PR
// default runs driveStages instead.
//
// PrPerTaskDeps is the narrow port WorkLoop builds per group-run (mirrors StageDeps in
// stage-handlers.ts): checkout-agnostic execution ports plus the WorkLoop-owned bookkeeping
// (markStatus, persistAfterSideEffect, outcome tracking, progress/step rendering) this mode shares
// with driveStages.

import type { PrGroup } from '../domain/pr-group.ts';
import type { Task } from '../domain/task.ts';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';
import { CiFailed } from '../github/errors.ts';
import type { MergeMethod } from '../github/github-client.ts';
import type { PullRequest } from '../github/schema.ts';
import type { RunStep } from '../observability/step-progress.ts';
import { perTaskBranch } from '../workspace/branch-name.ts';
import type { Checkout } from '../workspace/in-place-checkout.ts';
import { type CiRoute, chargeCiFixAttempt, routeCiPoll } from './ci-outcome-policy.ts';
import type { StageWorkResult } from './stage-handlers.ts';
import type {
  CheckoutHome,
  GroupOutcome,
  RunOneTaskResult,
  WorkLoopDeps,
  WorkLoopGithub,
  WorkLoopOrchestrator,
} from './work-loop.ts';

// The Error autoMergeFlow throws when a recovery session reports 'blocked' — named, pure function
// (same message text as before) so `{cause}` is unit-testable without wiring the whole flow, and so
// the StageWorkResult that explains WHY it blocked isn't discarded at the throw the way a bare
// `${fix.reason}` interpolation would.
export function ciFixFailedError(fix: Extract<StageWorkResult, { kind: 'blocked' }>): Error {
  return new Error(`worker CI fix failed: ${fix.reason}`, { cause: fix });
}

export function reviewFailedError(review: Extract<StageWorkResult, { kind: 'blocked' }>): Error {
  return new Error(`reviewer failed: ${review.reason}`, { cause: review });
}

// Thrown by autoMergeFlow when the run is cancelled mid-CI-wait. A throw, not an early return: the
// caller's next step is `gh pr merge`, and a silent return would record the group merged.
// runGroup's catch turns it into a blocked group, which run() then reports as cancelled.
class RunCancelled extends Error {
  override readonly name = 'RunCancelled';
  constructor() {
    super('run cancelled');
  }
}

// The subset of WorkLoop's ports and bookkeeping this mode drives. Built once per group-run by
// WorkLoop.buildPrPerTaskDeps, which owns the checkout, base branch, and every method here that
// touches the WorkLoop's shared state (outcomes, groupStartedAt, persisted stage/status writes) —
// the same bridging role buildStageDeps plays for driveStages.
export type PrPerTaskDeps = {
  orchestrator: Pick<WorkLoopOrchestrator, 'openPr' | 'runCiFix' | 'addressReviews'>;
  github: Pick<WorkLoopGithub, 'waitForChecks' | 'listUnresolvedThreads' | 'mergePr'>;
  home: Pick<CheckoutHome, 'resetToBase'>;
  autoMerge: boolean;
  adminMerge: boolean;
  mergeMethod: MergeMethod;
  maxCiFixAttempts: number;
  signal?: AbortSignal;
  progress?: WorkLoopDeps['progress'];
  runOneTask(
    group: PrGroup,
    task: Task,
    checkout: Checkout,
    baseBranch: string,
  ): Promise<RunOneTaskResult>;
  maybeSelfReview(
    group: PrGroup,
    delivery: WorkerDelivery,
    checkout: Checkout,
    baseBranch: string,
  ): Promise<void>;
  markStatus(
    id: string,
    status: PrGroup['status'],
    patch?: Partial<
      Pick<PrGroup, 'branch' | 'pr' | 'prUrl' | 'stage' | 'ciFixAttempts' | 'humanNeeded'>
    >,
  ): Promise<void>;
  persistAfterSideEffect(outcome: GroupOutcome, write: () => Promise<void>): Promise<void>;
  discardMergedBranch(groupId: string, branch: string | null): Promise<void>;
  stepFor(groupId: string, phase: string, task?: Task): RunStep;
  groupElapsedLabel(groupId: string): string;
  outcomesFor(groupId: string): GroupOutcome[];
  pushOutcome(outcome: GroupOutcome): void;
};

// Base-fresh per task: under autoMerge each task's PR merges before the next task runs, so the next
// task must start from the freshly-merged base. Otherwise, with the default squash merge, task N's
// original branch commit is not an ancestor of the base's new squash commit, and task N+1's PR —
// opened from the same branch — re-includes task N's changes (each successive PR grows). So under
// autoMerge every task gets its OWN branch reset off origin/<base> via home.resetToBase, mirroring
// claudetm's fresh `git checkout -b` per task. Without autoMerge there is no merged base to branch
// from mid-group, and a home without resetToBase (test stubs) can't reset either — both fall back to
// the single group branch, opening a PR per task off it.
export async function runPrPerTaskGroup(
  deps: PrPerTaskDeps,
  group: PrGroup,
  checkout: Checkout,
  baseBranch: string,
): Promise<void> {
  let remaining = group.tasks.filter((t) => !t.done).length;
  if (remaining === 0) {
    // Every task was already done on entry — a resumed group whose work finished in a prior run but
    // which never opened a PR. There's no fresh delivery to compose one from, so surface it as
    // blocked rather than fabricating an empty PR.
    await deps.markStatus(group.id, 'blocked');
    deps.pushOutcome({
      groupId: group.id,
      status: 'blocked',
      reason: 'all tasks already complete but no pull request was opened',
    });
    return;
  }

  // Keep the home reference and call resetToBase AS A METHOD — extracting it to a bare local
  // (`const fn = home.resetToBase`) drops the `this` binding, and the real InPlaceCheckout reads
  // `this.current`, so a detached call throws "undefined is not an object".
  const home = deps.home;
  const canResetToBase = deps.autoMerge && typeof home.resetToBase === 'function';
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
    const result = await deps.runOneTask(worked, task, co, baseBranch);
    if (result.kind === 'blocked') {
      // Surface the reason live — this task-blocked path otherwise marks the group blocked
      // SILENTLY (no progress line), so a failed task looks like the group just vanished.
      deps.progress?.(
        `group ${group.id} task ${task.id}: → blocked (${result.reason})`,
        deps.stepFor(group.id, 'blocked', task),
      );
      await deps.markStatus(group.id, 'blocked');
      deps.pushOutcome({ groupId: group.id, status: 'blocked', reason: result.reason });
      return;
    }
    worked = result.group;
    remaining -= 1;
    // Only the last task may mark the group terminal. Marking the whole group awaiting-pr/merged
    // after an earlier task's PR would strand the still-undone tasks: a crash there leaves a
    // terminal group PlanGraph.ready() won't reschedule. While tasks remain, the group stays
    // in-progress (schedulable on resume).
    await openAndMaybeMerge(deps, worked, result.delivery, co, baseBranch, remaining === 0);
  }
}

// Open the PR for one delivery, persist the outcome, and — under autoMerge — run the CI/review/
// merge flow. Invoked once per task. `final` is true only for the last undone task: until then the
// group's persisted status stays 'in-progress' (schedulable) so a crash between per-task PRs leaves
// the remaining tasks runnable on resume. External side effects (openPr/mergePr) are guarded by
// PrPerTaskDeps.persistAfterSideEffect so a failed state write never rolls a landed PR back to
// 'blocked'.
async function openAndMaybeMerge(
  deps: PrPerTaskDeps,
  group: PrGroup,
  delivery: WorkerDelivery,
  checkout: Checkout,
  baseBranch: string,
  final: boolean,
): Promise<void> {
  await deps.maybeSelfReview(group, delivery, checkout, baseBranch);
  const opened = await deps.orchestrator.openPr(group, delivery, baseBranch);
  if (opened === 'nothing-to-ship') {
    // The task completed without adding commits (a declared no-changes task) — no PR to open or
    // merge. Only the final task may mark the group terminal (same rule as the PR path below); its
    // terminal must not overwrite what earlier tasks' PRs established: with an earlier PR still
    // awaiting merge the group stays awaiting-pr, and a fresh merged outcome is pushed only when no
    // earlier task recorded one (an all-no-changes group).
    if (final) {
      const prior = deps.outcomesFor(group.id);
      const awaiting = prior.some((o) => o.status === 'awaiting-pr');
      await deps.markStatus(group.id, awaiting ? 'awaiting-pr' : 'merged');
      if (prior.length === 0) {
        deps.pushOutcome({ groupId: group.id, status: 'merged', pr: null });
      }
      deps.progress?.(
        `group ${group.id}: done — nothing to ship for the final task (${deps.groupElapsedLabel(group.id)})`,
        deps.stepFor(group.id, 'merged'),
      );
    }
    return;
  }
  const pr = opened;
  await deps.persistAfterSideEffect(
    { groupId: group.id, status: 'awaiting-pr', pr: pr.number },
    () =>
      deps.markStatus(group.id, final ? 'awaiting-pr' : 'in-progress', {
        pr: pr.number,
        prUrl: pr.url,
      }),
  );

  if (!deps.autoMerge) {
    deps.pushOutcome({ groupId: group.id, status: 'awaiting-pr', pr: pr.number });
    return;
  }

  await autoMergeFlow(deps, group, pr, checkout, baseBranch);
  await deps.persistAfterSideEffect({ groupId: group.id, status: 'merged', pr: pr.number }, () =>
    deps.markStatus(group.id, final ? 'merged' : 'in-progress'),
  );
  deps.pushOutcome({ groupId: group.id, status: 'merged', pr: pr.number });
  // Delete the branch only after the group's FINAL task merges. Every task shares one branch, reset
  // to base between tasks (resetToBase) — deleting it after an intermediate task would pull the
  // ground out from under the next one. A non-final task keeps it.
  if (final) {
    await deps.discardMergedBranch(group.id, group.branch);
    deps.progress?.(
      `group ${group.id}: merged — done in ${deps.groupElapsedLabel(group.id)}`,
      deps.stepFor(group.id, 'merged'),
      { milestone: true },
    );
  }
}

// CI recovery loop — the prPerTask twin of driveStages' waiting-ci ⇄ ci-failed cycle, sharing its
// ciOutcomePolicy so both honor --admin's CI-timeout override and the maxCiFixAttempts cap. Wait →
// route → maybe fix → re-wait, until CI is green (or --admin skips a timeout past CI), the fix can't
// land, or the budget is spent. The fix session pushes (Worker → rebase onto origin/<base> →
// force-with-lease) so each recheck polls the pushed fix, not stale remote CI. Each task PR gets a
// fresh budget: it merges before the next task runs, so there is nothing to carry across tasks
// (unlike the stage machine's single per-group PR, whose count persists onto PrGroup.ciFixAttempts).
async function autoMergeFlow(
  deps: PrPerTaskDeps,
  group: PrGroup,
  pr: PullRequest,
  checkout: Checkout,
  baseBranch: string,
): Promise<void> {
  const { orchestrator, github, signal, adminMerge } = deps;

  let fixSpent = 0;
  while (true) {
    let route: CiRoute;
    let timeout: CiFailed | undefined;
    try {
      const ci = await github.waitForChecks(pr.number, signal);
      // A cancelled wait comes back 'pending', which would route as not-green and fall through to a
      // fix (or past it to the merge). Stop the group instead.
      throwIfCancelled(deps);
      route = routeCiPoll(ci.state, pr.number, adminMerge);
    } catch (err) {
      if (!(err instanceof CiFailed)) throw err;
      timeout = err;
      route = routeCiPoll(null, pr.number, adminMerge);
    }
    // green, or --admin force-advancing a timeout past CI → proceed to reviews/merge.
    if (route.kind === 'proceed' || route.kind === 'advance') break;
    // Timeout without --admin: block on the original CiFailed (its message names the poll window).
    if (route.kind === 'block') throw timeout ?? new CiFailed(route.reason);
    // route.kind === 'fix': charge the budget BEFORE spending an LLM call / a push, so an unfixable
    // red PR blocks after maxCiFixAttempts passes instead of looping forever.
    const charge = chargeCiFixAttempt(fixSpent, deps.maxCiFixAttempts, pr.number);
    fixSpent = charge.spent;
    if (charge.kind === 'exhausted') throw new CiFailed(charge.reason);
    const fix = await orchestrator.runCiFix({ group, pr: pr.number, checkout, baseBranch });
    if (fix.kind !== 'ok') throw ciFixFailedError(fix);
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

  await github.mergePr(pr.number, deps.mergeMethod, { admin: deps.adminMerge });
}

function throwIfCancelled(deps: PrPerTaskDeps): void {
  if (deps.signal?.aborted) throw new RunCancelled();
}

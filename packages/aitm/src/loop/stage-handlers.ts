// PR-lifecycle stage handlers. One pure-ish function per workflow stage: each performs that
// stage's single transition and returns the next GroupStage. The dispatcher (WorkLoop.runGroup,
// task 20) drives them — it persists the returned stage and re-reads the group between handlers,
// so a crashed/paused run resumes mid-PR at its persisted stage instead of redoing prior stages.
// Mirrors claude-task-master's per-stage handlers (core/workflow_stages.py / _run_workflow_cycle).
//
// Transition map (claudetm-exact):
//   working → pr-open → waiting-ci → (ci-failed → waiting-ci | waiting-reviews)
//           → (addressing-reviews → waiting-reviews | ready-to-merge) → merged
// 'merged'/'blocked' are terminal (no handler); 'pending' is pre-working (the dispatcher kicks it).
//
// Handlers stay decision-only: execution detail (worktree, subagents, git) lives behind the
// `orchestrator` port, and persisting the *stage* is the dispatcher's job. A handler persists only
// the data IT produces — handlePrOpen records the PR number right after the side effect so a later
// state-write failure never loses an opened PR (cf. WorkLoop's StateWriteAfterSuccess guard).
//
// ci-failed / addressing-reviews are stubbed here; their bodies (download logs/comments → fix
// session / Reviewer → rebase+force-with-lease → re-poll) land in slice 04. Until then they block
// the group rather than loop forever back into waiting-ci/waiting-reviews.

import { CiFailed } from '../github/errors.ts';
import type { CiResult } from '../github/github-client.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { GroupStage, PrGroup, RunState } from '../state/schema.ts';
import type { PrContextPort } from './take-over-flow.ts';

// Subset of GitHubClient the stage machine drives. The merge method is a run option, not a
// per-stage decision, so it's bound at construction and handleReadyToMerge just calls mergePr(pr).
export type StageGithub = {
  // Block until CI settles: returns the aggregate CiResult; throws CiFailed only on poll timeout.
  waitForChecks(pr: number): Promise<CiResult>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number): Promise<void>;
};

export type StageWorkResult = { kind: 'ok' } | { kind: 'blocked'; reason: string };

// Worktree-bound execution facade, built per group-run by the dispatcher (which owns the worktree,
// base branch and subagents). Its methods take the group so the handlers stay worktree-agnostic.
export type StageOrchestrator = {
  // Run every not-yet-done task in the group (Worker → finalize commit → mark done → persist),
  // in order, leaving the branch holding all the group's commits. Idempotent on resume: tasks
  // already marked done are skipped. Returns blocked when a Worker pass can't complete.
  work(group: PrGroup): Promise<StageWorkResult>;
  // Push the group branch and open its PR from the work() delivery; returns the new PR number.
  openPr(group: PrGroup): Promise<number>;
};

// Narrow state surface: handlers persist the data they produce. StateStore satisfies it.
export type StageState = {
  update(mutator: (s: RunState) => RunState): Promise<RunState>;
};

export type StageDeps = {
  github: StageGithub;
  orchestrator: StageOrchestrator;
  state: StageState;
  // Downloaded CI-log / review-comment store, consumed by the ci-failed / addressing-reviews
  // handlers in slice 04. Unused by the stages implemented below.
  prContext?: PrContextPort;
};

export type StageHandler = (deps: StageDeps, group: PrGroup) => Promise<GroupStage>;

// working: drive the group's tasks to commits on its branch, then advance to open the PR.
export const handleWorking: StageHandler = async (deps, group) => {
  const result = await deps.orchestrator.work(group);
  return result.kind === 'ok' ? 'pr-open' : 'blocked';
};

// pr-open: open the PR, record its number, then wait for CI. Idempotent: if the group already
// carries a PR (a crash between opening it and persisting the next stage), don't open a second one.
export const handlePrOpen: StageHandler = async (deps, group) => {
  if (group.pr !== null) return 'waiting-ci';
  const pr = await deps.orchestrator.openPr(group);
  await deps.state.update((s) => ({
    ...s,
    prGroups: s.prGroups.map((g) => (g.id === group.id ? { ...g, pr } : g)),
  }));
  return 'waiting-ci';
};

// waiting-ci: block on checks. Success → review; a 'failure'/'pending' state or a CiFailed timeout
// → ci-failed for the fix loop.
export const handleWaitingCi: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'waiting-ci');
  try {
    const { state } = await deps.github.waitForChecks(pr);
    return state === 'success' ? 'waiting-reviews' : 'ci-failed';
  } catch (err) {
    if (err instanceof CiFailed) return 'ci-failed';
    throw err;
  }
};

// waiting-reviews: unresolved threads → address them; none → merge.
export const handleWaitingReviews: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'waiting-reviews');
  const threads = await deps.github.listUnresolvedThreads(pr);
  return threads.length === 0 ? 'ready-to-merge' : 'addressing-reviews';
};

// ready-to-merge: merge with the run's configured method, then terminal.
export const handleReadyToMerge: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'ready-to-merge');
  await deps.github.mergePr(pr);
  return 'merged';
};

// ci-failed — slice 04: download failed CI logs (prContext) → shared fix session → rebase +
// force-with-lease → back to waiting-ci. Until then, a CI failure blocks the group.
export const handleCiFailed: StageHandler = async (_deps, _group) => 'blocked';

// addressing-reviews — slice 04: download review comments (prContext) → Reviewer addresses each
// thread → push → back to waiting-reviews. Until then, unresolved reviews block the group.
export const handleAddressingReviews: StageHandler = async (_deps, _group) => 'blocked';

// The post-working stages all operate on an open PR. A null pr here means the dispatcher routed a
// group into a PR stage without one — a bug, not a recoverable state — so fail loudly.
function requirePr(group: PrGroup, stage: GroupStage): number {
  if (group.pr === null) {
    throw new Error(`group ${group.id} entered stage '${stage}' without an open PR`);
  }
  return group.pr;
}

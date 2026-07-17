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
// Handlers stay decision-only: execution detail (checkout, subagents, git) lives behind the
// `orchestrator` port, and persisting the *stage* is the dispatcher's job. A handler persists only
// the data IT produces — handlePrOpen records the PR number right after the side effect so a later
// state-write failure never loses an opened PR (cf. WorkLoop's StateWriteAfterSuccess guard).
//
// ci-failed and addressing-reviews drive the recovery loops: ci-failed delegates to the shared fix
// session (download logs/comments → Worker → rebase + force-with-lease) and loops back to
// waiting-ci; addressing-reviews runs the Reviewer over the not-yet-addressed threads and loops back
// to waiting-reviews. The addressed-threads dedup (prContext) is what lets the waiting-reviews ⇄
// addressing-reviews loop terminate instead of re-processing a replied-but-unresolved thread.

import { CiFailed } from '../github/errors.ts';
import { type CiResult, defaultSleep, type Sleep } from '../github/github-client.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { GroupStage, PrGroup, RunState } from '../state/schema.ts';
import { REVIEW_COMMENTS_GRACE } from './constants.ts';

// Subset of GitHubClient the stage machine drives. The merge method is a run option, not a
// per-stage decision, so it's bound at construction and handleReadyToMerge just calls mergePr(pr).
export type StageGithub = {
  // Block until CI settles: returns the aggregate CiResult; throws CiFailed only on poll timeout.
  waitForChecks(pr: number): Promise<CiResult>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number): Promise<void>;
};

export type StageWorkResult = { kind: 'ok' } | { kind: 'blocked'; reason: string };

// Checkout-bound execution facade, built per group-run by the dispatcher (which owns the checkout,
// base branch and subagents). Its methods take the group so the handlers stay checkout-agnostic.
export type StageOrchestrator = {
  // Run every not-yet-done task in the group (Worker → finalize commit → mark done → persist),
  // in order, leaving the branch holding all the group's commits. Idempotent on resume: tasks
  // already marked done are skipped. Returns blocked when a Worker pass can't complete.
  work(group: PrGroup): Promise<StageWorkResult>;
  // Push the group branch and open its PR from the work() delivery; returns the new PR number.
  openPr(group: PrGroup): Promise<number>;
  // ci-failed: download the failed CI logs + unresolved comments, run the shared fix session
  // (Worker pass), then rebase onto origin/<base> and force-with-lease push so CI re-runs. ok →
  // waiting-ci; blocked → the fix couldn't land (still red, or a rebase conflict needing a human).
  fixCi(group: PrGroup): Promise<StageWorkResult>;
  // addressing-reviews: run the Reviewer over these (already deduped) threads — it replies/resolves
  // via its github tool and pushes any code fixes. ok → the threads were handled; blocked → it
  // couldn't (agent error / failed push).
  addressReviews(group: PrGroup, threads: ReviewThread[]): Promise<StageWorkResult>;
};

// Narrow state surface: handlers persist the data they produce. StateStore satisfies it.
export type StageState = {
  update(mutator: (s: RunState) => RunState): Promise<RunState>;
};

// Tracks review threads the addressing-reviews loop has already run the Reviewer over, so a re-poll
// never re-processes a thread it merely replied to (those stay unresolved). PrContextStore satisfies
// this. Optional on StageDeps: when omitted, no thread is considered addressed.
export type AddressedThreadsStore = {
  readAddressedThreads(pr: number): Promise<Set<string>>;
  recordAddressedThreads(pr: number, ids: readonly string[]): Promise<void>;
};

export type StageDeps = {
  github: StageGithub;
  orchestrator: StageOrchestrator;
  state: StageState;
  // Addressed-thread bookkeeping for the addressing-reviews loop. Optional — without it every
  // unresolved thread is treated as fresh (the loop still terminates once threads get resolved).
  prContext?: AddressedThreadsStore;
  // Delay primitive for the post-CI review grace. Optional — defaults to a real timer; tests inject
  // a no-op so they don't block on the 2-minute wait.
  sleep?: Sleep;
  // When true, a CI-poll timeout force-advances to reviews (a policy override) instead of blocking.
  // Threaded from `--admin`. Default false: a timeout blocks rather than merging a PR whose CI never
  // finished. Only affects the timeout path — a real CI failure still routes to the fix loop.
  adminMerge?: boolean;
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

// waiting-ci: block on checks. Success → review; a 'failure' state → ci-failed for the fix loop. A
// CiFailed timeout (CI never finished within CHECKS_TIMEOUT_MS) → block, so we don't merge a PR whose
// CI never completed — unless --admin is set, which force-advances to reviews as a policy override.
export const handleWaitingCi: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'waiting-ci');
  try {
    const { state } = await deps.github.waitForChecks(pr);
    if (state !== 'success') return 'ci-failed';
    // Review bots (CodeRabbit) post their comments a little *after* CI completes rather than as a
    // blocking status check. Give them a grace window to land before waiting-reviews reads the
    // unresolved threads — otherwise we'd advance to merge ahead of the review.
    await (deps.sleep ?? defaultSleep)(REVIEW_COMMENTS_GRACE);
    return 'waiting-reviews';
  } catch (err) {
    if (err instanceof CiFailed) return deps.adminMerge ? 'waiting-reviews' : 'blocked';
    throw err;
  }
};

// waiting-reviews: not-yet-addressed unresolved threads → address them; none → merge. Subtracting
// the addressed set (not just checking listUnresolvedThreads) is what terminates the loop: a thread
// the Reviewer replied to but left unresolved would otherwise route back here forever.
export const handleWaitingReviews: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'waiting-reviews');
  const fresh = await freshThreads(deps, pr);
  return fresh.length === 0 ? 'ready-to-merge' : 'addressing-reviews';
};

// ready-to-merge: merge with the run's configured method, then terminal.
export const handleReadyToMerge: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'ready-to-merge');
  await deps.github.mergePr(pr);
  return 'merged';
};

// ci-failed: run the shared fix session via the orchestrator (download → Worker → rebase +
// force-with-lease) and loop back to waiting-ci so the freshly-pushed commit re-runs CI. A fix that
// can't land (still red, or a rebase conflict) blocks the group for a human.
export const handleCiFailed: StageHandler = async (deps, group) => {
  requirePr(group, 'ci-failed');
  const result = await deps.orchestrator.fixCi(group);
  return result.kind === 'ok' ? 'waiting-ci' : 'blocked';
};

// addressing-reviews: run the Reviewer over the not-yet-addressed threads, record them as addressed,
// and loop back to waiting-reviews. When nothing is fresh (every unresolved thread was already
// handled), hand straight back — waiting-reviews then sees no fresh threads and advances to merge.
export const handleAddressingReviews: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'addressing-reviews');
  const fresh = await freshThreads(deps, pr);
  if (fresh.length === 0) return 'waiting-reviews';
  const result = await deps.orchestrator.addressReviews(group, fresh);
  if (result.kind === 'blocked') return 'blocked';
  await deps.prContext?.recordAddressedThreads(
    pr,
    fresh.map((t) => t.id),
  );
  return 'waiting-reviews';
};

// The post-working stages all operate on an open PR. A null pr here means the dispatcher routed a
// group into a PR stage without one — a bug, not a recoverable state — so fail loudly.
function requirePr(group: PrGroup, stage: GroupStage): number {
  if (group.pr === null) {
    throw new Error(`group ${group.id} entered stage '${stage}' without an open PR`);
  }
  return group.pr;
}

// Unresolved threads the addressing loop hasn't run the Reviewer over yet: listUnresolvedThreads
// minus readAddressedThreads. The dedup terminates the waiting-reviews ⇄ addressing-reviews loop —
// a thread the Reviewer only replied to stays unresolved, so without subtracting the addressed set
// it would be re-processed on every poll.
async function freshThreads(deps: StageDeps, pr: number): Promise<ReviewThread[]> {
  const unresolved = await deps.github.listUnresolvedThreads(pr);
  const addressed = (await deps.prContext?.readAddressedThreads(pr)) ?? new Set<string>();
  return unresolved.filter((t) => !addressed.has(t.id));
}

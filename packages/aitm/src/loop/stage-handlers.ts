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
import {
  type CheckSummary,
  type CiResult,
  defaultSleep,
  type Sleep,
} from '../github/github-client.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { GroupStage, PrGroup, RunState } from '../state/schema.ts';
import { type CiRoute, routeCiPoll } from './ci-outcome-policy.ts';
import { REVIEW_COMMENTS_GRACE } from './constants.ts';

// Subset of GitHubClient the stage machine drives. The merge method is a run option, not a
// per-stage decision, so it's bound at construction and handleReadyToMerge just calls mergePr(pr).
export type StageGithub = {
  // Block until CI settles: returns the aggregate CiResult; throws CiFailed only on poll timeout.
  // The optional signal cancels the poll — an aborted wait returns a non-verdict 'pending' result
  // (GitHubClient.waitForChecks), which is why every caller re-checks the signal before branching.
  waitForChecks(pr: number, signal?: AbortSignal): Promise<CiResult>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number): Promise<void>;
  // The login `gh` is authenticated as, so freshThreads can recognize the Reviewer's own replies and
  // skip a thread it already replied to. Optional — when absent (or it throws), the dedup falls back
  // to the addressed-thread record alone.
  authenticatedLogin?(): Promise<string>;
};

export type StageWorkResult = { kind: 'ok' } | { kind: 'blocked'; reason: string };

// A stage handler returns either the next GroupStage, or — when it blocks — the next stage paired
// with the SPECIFIC human reason (which checks failed, whether a rebase conflicted, etc.). The
// dispatcher threads that reason into the group's persisted block reason so an operator sees what
// actually happened, instead of a generic either/or. Handlers that block without a specific reason
// still return the bare 'blocked' string; the dispatcher falls back to blockReasonFor then.
export type StageHandlerResult = GroupStage | { stage: 'blocked'; reason: string };

// Checkout-bound execution facade, built per group-run by the dispatcher (which owns the checkout,
// base branch and subagents). Its methods take the group so the handlers stay checkout-agnostic.
// What a freshly opened PR carries back to the stage machine: its number for every later `gh` call,
// and its URL so the run can print a link rather than a number.
export type OpenedPr = { number: number; url: string };

export type StageOrchestrator = {
  // Run every not-yet-done task in the group (Worker → finalize commit → mark done → persist),
  // in order, leaving the branch holding all the group's commits. Idempotent on resume: tasks
  // already marked done are skipped. Returns blocked when a Worker pass can't complete.
  work(group: PrGroup): Promise<StageWorkResult>;
  // Push the group branch and open its PR from the work() delivery; returns the new PR's number and
  // web URL (the URL is persisted so every later report can link to it). Returns null when the
  // branch adds no commits over the base (every task completed without a commit) — there is nothing
  // to ship, and the group completes without a PR.
  openPr(group: PrGroup): Promise<OpenedPr | null>;
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
  // Run cancellation (SIGINT), threaded from WorkLoopDeps.signal. It cancels the CI poll and the
  // review grace, and a handler that finds it aborted hands back its CURRENT stage rather than a
  // transition: a cancelled run must not persist a stage it never really reached (a 'ci-failed' a
  // resume would then "fix" on a PR whose CI never failed) nor advance toward the merge. The
  // dispatcher owns ending the group. Unset → no cancellation, byte-identical to before.
  signal?: AbortSignal;
  // When true, a CI-poll timeout force-advances to reviews (a policy override) instead of blocking.
  // Threaded from `--admin`. Default false: a timeout blocks rather than merging a PR whose CI never
  // finished. Only affects the timeout path — a real CI failure still routes to the fix loop.
  adminMerge?: boolean;
  // Harness narration sink (the WorkLoop's progress tee). Optional — without it CI settles silently,
  // as before. Used for the one-line "CI settled" check summary.
  progress?: (message: string) => void;
};

export type StageHandler = (deps: StageDeps, group: PrGroup) => Promise<StageHandlerResult>;

// working: drive the group's tasks to commits on its branch, then advance to open the PR.
export const handleWorking: StageHandler = async (deps, group) => {
  const result = await deps.orchestrator.work(group);
  return result.kind === 'ok' ? 'pr-open' : 'blocked';
};

// pr-open: open the PR, record its number, then wait for CI. Idempotent: if the group already
// carries a PR (a crash between opening it and persisting the next stage), don't open a second one.
// A null from openPr means the branch adds no commits over the base (nothing to ship): the group is
// done without a PR, so it goes straight to the merged terminal instead of blocking the run.
export const handlePrOpen: StageHandler = async (deps, group) => {
  if (group.pr !== null) return 'waiting-ci';
  const opened = await deps.orchestrator.openPr(group);
  if (opened === null) return 'merged';
  await deps.state.update((s) => ({
    ...s,
    prGroups: s.prGroups.map((g) =>
      g.id === group.id ? { ...g, pr: opened.number, prUrl: opened.url } : g,
    ),
  }));
  return 'waiting-ci';
};

// waiting-ci: block on checks. Success → review; a 'failure' state → ci-failed for the fix loop. A
// CiFailed timeout (CI never finished within CHECKS_TIMEOUT_MS) → block, so we don't merge a PR whose
// CI never completed — unless --admin is set, which force-advances to reviews as a policy override.
export const handleWaitingCi: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'waiting-ci');
  if (deps.signal?.aborted) return 'waiting-ci';
  let route: CiRoute;
  try {
    const result = await deps.github.waitForChecks(pr, deps.signal);
    // A cancelled poll returns early WITHOUT a verdict ('pending'), which the fix route below would
    // read as "CI is not green" and route to ci-failed — persisting a stage a resume would act on
    // by running a fix session against a PR whose CI never actually failed.
    if (deps.signal?.aborted) return 'waiting-ci';
    // One line, once, when CI settles — the checks and their final buckets, so the operator sees
    // WHAT passed/failed without watching GitHub or reading a poll spam.
    const summary = formatCheckSummary(result.checks);
    if (summary !== '') deps.progress?.(`group ${group.id}: CI ${result.state} — ${summary}`);
    route = routeCiPoll(result.state, pr, deps.adminMerge ?? false);
  } catch (err) {
    if (!(err instanceof CiFailed)) throw err;
    route = routeCiPoll(null, pr, deps.adminMerge ?? false);
  }
  switch (route.kind) {
    case 'fix':
      return 'ci-failed';
    // A timeout without --admin blocks; the dispatcher fills the human reason via blockReasonFor.
    // (The policy's block reason serves autoMergeFlow, which has no such fallback.)
    case 'block':
      return 'blocked';
    case 'advance':
      return 'waiting-reviews';
    default: {
      // Review bots (CodeRabbit) post their comments a little *after* CI completes rather than as a
      // blocking status check. Give them a grace window to land before waiting-reviews reads the
      // unresolved threads — otherwise we'd advance to merge ahead of the review. Only sleep once per
      // group, since the waiting-ci handler may be called again if the loop revisits this stage
      // (e.g. after addressing reviews and re-polling CI).
      if (!group.reviewGraceApplied) {
        await (deps.sleep ?? defaultSleep)(REVIEW_COMMENTS_GRACE, deps.signal);
        // The grace resolves early on abort; advancing then would hand the cancelled run to
        // waiting-reviews, one transition away from merging a PR the operator stopped.
        if (deps.signal?.aborted) return 'waiting-ci';
        // Mark the grace as applied so re-visits to this stage don't sleep again.
        await deps.state.update((s) => ({
          ...s,
          prGroups: s.prGroups.map((g) =>
            g.id === group.id ? { ...g, reviewGraceApplied: true } : g,
          ),
        }));
      }
      return 'waiting-reviews';
    }
  }
};

// waiting-reviews: not-yet-addressed unresolved threads → address them; none → merge. Subtracting
// the addressed set (not just checking listUnresolvedThreads) is what terminates the loop: a thread
// the Reviewer replied to but left unresolved would otherwise route back here forever.
// A one-line rendering of the settled checks: `bun (test+lint) ✓, integration ✓, CodeRabbit ✗`.
// '' when there were no checks (nothing worth a line). A ✓ for the pass/skipping buckets, ✗ for
// fail/cancel, · for anything else gh reports. Exported for unit testing.
export function formatCheckSummary(checks: CheckSummary[] | undefined): string {
  if (checks === undefined || checks.length === 0) return '';
  return checks.map((c) => `${c.name} ${checkMark(c.bucket)}`).join(', ');
}

function checkMark(bucket: string): string {
  if (bucket === 'pass' || bucket === 'skipping') return '✓';
  if (bucket === 'fail' || bucket === 'cancel') return '✗';
  return '·';
}

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
// can't land carries its SPECIFIC reason (a rebase conflict the AI resolver couldn't close, a push
// failure, or a Worker that couldn't produce a fix) so the operator sees what really happened — not
// a generic either/or that falsely implies a conflict when none exists.
export const handleCiFailed: StageHandler = async (deps, group) => {
  requirePr(group, 'ci-failed');
  const result = await deps.orchestrator.fixCi(group);
  if (result.kind === 'ok') return 'waiting-ci';
  return { stage: 'blocked', reason: result.reason };
};

// addressing-reviews: run the Reviewer over the not-yet-addressed threads, record them as addressed,
// and loop back to waiting-reviews. When nothing is fresh (every unresolved thread was already
// handled), hand straight back — waiting-reviews then sees no fresh threads and advances to merge.
export const handleAddressingReviews: StageHandler = async (deps, group) => {
  const pr = requirePr(group, 'addressing-reviews');
  const fresh = await freshThreads(deps, pr);
  if (fresh.length === 0) return 'waiting-reviews';
  const result = await deps.orchestrator.addressReviews(group, fresh);
  if (result.kind === 'blocked') return { stage: 'blocked', reason: result.reason };
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
// minus the addressed set minus threads that already carry a reply from us. The dedup terminates the
// waiting-reviews ⇄ addressing-reviews loop — a thread the Reviewer only replied to stays unresolved,
// so without subtracting it the thread would be re-processed on every poll.
//
// Two subtractions, because the addressed-thread record has a gap: the Reviewer's side effects (reply
// + push) land BEFORE recordAddressedThreads, so a crash in between loses the record and a resume
// would re-feed the thread → a duplicate reply. Reading our own reply straight off the thread closes
// that gap (durability #5) — a self-healing skip keyed on GitHub's actual state rather than our
// bookkeeping, which also heals a partial pass that replied but couldn't record (task 11's residue).
async function freshThreads(deps: StageDeps, pr: number): Promise<ReviewThread[]> {
  const unresolved = await deps.github.listUnresolvedThreads(pr);
  const addressed = (await deps.prContext?.readAddressedThreads(pr)) ?? new Set<string>();
  const botLogin = await botReplyLogin(deps);
  return unresolved.filter((t) => !addressed.has(t.id) && !hasReplyFrom(t, botLogin));
}

// The login `gh` is authenticated as, or undefined when it can't be resolved. Best-effort: the
// bot-reply skip is an enhancement over the addressed-set dedup, so a gh hiccup degrades to that
// record rather than breaking the review loop.
async function botReplyLogin(deps: StageDeps): Promise<string | undefined> {
  try {
    return await deps.github.authenticatedLogin?.();
  } catch {
    return undefined;
  }
}

// Whether the thread already carries a comment authored by us. A review thread is opened by a
// reviewer (CodeRabbit / a human), never by our own account, so a comment from `botLogin` can only be
// a reply we posted — meaning this thread was already addressed. Undefined login → never a match.
function hasReplyFrom(thread: ReviewThread, botLogin: string | undefined): boolean {
  return botLogin !== undefined && thread.comments.some((c) => c.author === botLogin);
}

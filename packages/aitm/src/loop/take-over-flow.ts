// Take-over merge flow. Drives an externally-built PR (Claude Code, gh pr create, etc.)
// to merge: waits for CI, runs Reviewer to address unresolved review threads (CodeRabbit
// + human reviewers), pushes fixes, and merges. Mirrors the claude-task-master
// `merge_pr()` shape from src/claude_task_master/cli_commands/fix_pr.py:
//
//   for iteration in 0..maxIterations:
//     status   = waitForChecks(pr)
//     threads  = listUnresolvedThreads(pr)
//     if status == success and threads.empty: break
//     if status == failure: runFixSession  # shared ci-fix.ts pipeline (download → coding Worker →
//                                           # rebase + force-push); loop back to re-poll CI
//     elif threads.any:    runReviewer per thread, then rebase + push --force-with-lease
//     sleep(cooldown)  # let CI restart
//   mergePr(pr)
//
// Like WorkLoop, this works in-place: the user is expected to be on the PR branch in their
// cwd; everything happens in the current checkout. That's the simpler model and matches how
// a human reviewer would handle it.
//
// docs/vendor/ai-sdk/chunk-09.md §"Subagents" — Reviewer/Worker are built ad-hoc per loop
// iteration because their tool bindings (checkout, threads) change each iteration.

import type { SubagentHandle } from '@developerz.ai/ai-claude-compat';
import type { LanguageModel, TimeoutConfiguration } from 'ai';
import type { PrGroup } from '../domain/pr-group.ts';
import { CiFailed } from '../github/errors.ts';
import {
  type CiResult,
  type CiState,
  defaultRunCmd,
  defaultSleep,
  type MergeMethod,
  type RunCmd,
  type Sleep,
} from '../github/github-client.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { SubagentInit, WorkerSubagentInit } from '../subagents/factory.ts';
import {
  createReviewerAgent,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerResult,
  type ReviewerTools,
  runReviewer,
} from '../subagents/reviewer.ts';
import { harnessContextBlock, reminderAgentSystemPrompt } from '../subagents/role-prompt.ts';
import type { WorkerInput, WorkerResult, WorkerTools } from '../subagents/worker.ts';
import {
  type ConflictResolver,
  type FixSessionModelSelector,
  type FixSessionResult,
  rebaseAndForcePush,
  runFixSession,
} from './ci-fix.ts';
import { DEFAULT_MAX_ITERATIONS, REVIEW_COMMENTS_GRACE } from './constants.ts';
import type { BudgetStatus } from './work-loop.ts';

// Minimal slice of GitHubClient used by the flow. Structural so tests can stub it.
export type TakeOverGithub = {
  // The optional signal cancels the CI poll; an aborted wait returns without a verdict
  // ('pending'), so the loop re-checks the signal before acting on the result.
  waitForChecks(pr: number, signal?: AbortSignal): Promise<CiResult>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number, method: MergeMethod, opts?: { admin?: boolean }): Promise<void>;
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
  // Full failed-CI logs, downloaded by the shared CI-fix session (runFixSession) so the coding-tier
  // Worker reads them off disk instead of guessing (issue #48). Present on the real GitHubClient.
  getFailedCiLogs(pr: number): Promise<Array<{ check: string; logs: string }>>;
  // The login `gh` is authenticated as, so freshThreads (below) can recognize the Reviewer's own
  // replies and skip a thread it already replied to. Optional — when absent (or it throws), the
  // dedup falls back to the addressed-thread record alone. Mirrors stage-handlers.ts's StageGithub.
  authenticatedLogin?(): Promise<string>;
};

// Persists downloaded PR context (CI logs / comments) to disk under the state dir. PrContextStore
// satisfies this; tests pass a stub. Structurally identical to ci-fix.ts's FixSessionPrContext —
// the shared CI-fix session writes the take-over's context through it.
export type PrContextPort = {
  clearCi(pr: number): Promise<void>;
  clearComments(pr: number): Promise<void>;
  saveCiFailures(
    pr: number,
    failures: ReadonlyArray<{ check: string; logs: string }>,
  ): Promise<string | null>;
  saveComments(pr: number, threads: readonly ReviewThread[]): Promise<string | null>;
  // Review threads the Reviewer has already run over, so a re-poll never re-processes a thread it
  // merely replied to (those can stay unresolved on GitHub). Mirrors stage-handlers.ts's
  // AddressedThreadsStore — PrContextStore satisfies both.
  readAddressedThreads(pr: number): Promise<Set<string>>;
  recordAddressedThreads(pr: number, ids: readonly string[]): Promise<void>;
};

// Subagent factories injected so tests can swap them for stubs without touching the AI SDK.
// Production passes the real factories: createReviewerAgent + runReviewer, etc.
export type TakeOverSubagents = {
  reviewerModel: LanguageModel;
  reviewerTools: ReviewerTools;
  // Model selector for the shared CI-fix session. It always fixes on modelForCapability('coding') —
  // the strongest code model — exactly like the WorkLoop ci-failed stage, so `merge-pr` and `start`
  // fix a red PR through the same pipeline instead of a weaker hand-rolled one.
  credentials: FixSessionModelSelector;
  workerTools: WorkerTools;
  // Style payload (CLAUDE.md / AGENTS.md). Prepended to subagent system prompts.
  styleContents: string;
  // Optional formatter command the CI-fix Worker runs before committing (issue #48).
  formatCommand?: string;
  // Optional verify command the CI-fix Worker runs before staging; a fix pass whose result still
  // fails verify blocks instead of rebasing and force-pushing a red commit (issue #122).
  verifyCommand?: string;
  // Per-step LLM request deadline, armed on both take-over agents (Worker + Reviewer). Unset → none.
  // Orthogonal to the flow's between-iterations `signal` cancel (issue #129).
  timeout?: TimeoutConfiguration;
  // Live progress stream for the take-over agents (silent-run fix): forwarded verbatim to both
  // agents' `onStepFinish`; the editor variant reaches the fix Worker's parallel fanout. Unset →
  // silent, matching prior behavior.
  onReviewerStepFinish?: SubagentInit<ReviewerTools>['onStepFinish'];
  onWorkerStepFinish?: SubagentInit<WorkerTools>['onStepFinish'];
  onEditorStepFinish?: WorkerSubagentInit<WorkerTools>['onEditorStepFinish'];
  // Per-call token-usage sinks (issue #114/#190) so `aitm merge-pr` accounts for its spend like
  // `aitm start`. The Worker sink covers the shared CI-fix session (recorded under the coding-tier
  // worker role); the Reviewer sink covers the review pass. A conflict resolver, when wired, carries
  // its own via buildConflictResolver. Unset → no accounting, matching prior behavior.
  onWorkerUsage?: SubagentInit<WorkerTools>['onUsage'];
  onReviewerUsage?: SubagentInit<ReviewerTools>['onUsage'];
  // Injection seam — bypass the real subagent agents in tests.
  runReviewerOverride?: (input: {
    pr: number;
    threads: ReviewThread[];
    checkoutPath: string;
    styleContents: string;
    // The #106 advisory context block the real runReviewer call receives (issue #141), so the
    // override is a faithful stand-in for the reviewer input.
    contextBlock: string;
  }) => Promise<ReviewerResult>;
  // Receives the full WorkerInput the real path would build (incl. formatCommand/verifyCommand/
  // logger), mirroring ci-fix.ts's FixSessionSubagents.runWorkerOverride.
  runWorkerOverride?: (input: WorkerInput) => Promise<WorkerResult>;
  // AI rebase-conflict resolver, threaded into the shared rebaseAndForcePush so a base that moved
  // under the PR is resolved and retried instead of blocking. Built by conflict-resolution.ts,
  // gated by config `resolveConflicts`; unset → today's abort+block. Stubbed in tests.
  resolveConflicts?: ConflictResolver;
};

export type TakeOverFlowInput = {
  pr: number;
  checkoutPath: string;
  baseBranch: string;
  github: TakeOverGithub;
  subagents: TakeOverSubagents;
  // Store for downloaded CI logs / comments (issue #48). The shared CI-fix session writes the full
  // failed-CI logs + review comments under .ai-task-master/debugging/pr/<pr>/ and points the
  // coding-tier Worker at them.
  prContext: PrContextPort;
  mergeMethod: MergeMethod;
  // When true, the final merge passes `gh pr merge --admin` to override base-branch policy
  // (e.g. "base branch policy prohibits the merge"). Default false. Threaded from `--admin`.
  adminMerge?: boolean;
  // Cap on iterations of the CI-wait/fix loop. Default DEFAULT_MAX_ITERATIONS (30), matching
  // claude-task-master's merge-pr loop. Threaded from `--max-iterations`; tests inject a small cap.
  maxIterations?: number;
  // Abort handle. When aborted (e.g. SIGINT), the loop bails out to `{ kind: 'cancelled' }` →
  // exit code 2, distinct from a `blocked` run (exit 1). Threaded into every blocking wait (the CI
  // poll, the review grace, the cooldown) and re-checked after each, so a cancel lands in seconds
  // instead of at the next iteration top — and never falls through to the merge.
  signal?: AbortSignal;
  // Sleep between iterations so the next `waitForChecks` actually sees fresh CI state
  // after a push. Default 5s. Tests inject a 0-ms sleep.
  cooldownMs?: number;
  sleep?: Sleep;
  // Run-level cost/token ceiling (issue #190), consulted at each iteration boundary BEFORE any new
  // CI-fix or Reviewer work is dispatched — mirrors WorkLoop's group-batch-boundary budget check
  // (work-loop.ts's `run()`), so `merge-pr` stops opening new spend the same way `start` does.
  // Built by merge-flow-adapter's makeBudgetCheck from the usage ledger + resolved ceilings. Unset →
  // no ceiling, byte-identical to before.
  budget?: () => Promise<BudgetStatus>;
  // git/gh shim — defaults to execa. Stubbed in unit tests to assert command shape without
  // spawning git. Every push after Reviewer/Worker commits goes through the shared
  // rebaseAndForcePush helper (ci-fix.ts): fetch origin <base> → rebase → push --force-with-lease.
  // Never a plain push (which fails against a rebased remote), never plain --force.
  runCmd?: RunCmd;
  // Force-push policy (from config allowForcePush). Default true. When false, the shared
  // rebaseAndForcePush refuses to push and the take-over blocks.
  allowForcePush?: boolean;
  logger?: LoggerLike;
};

export type TakeOverResult =
  | { kind: 'merged'; pr: number; iterations: number }
  | { kind: 'blocked'; reason: string; iterations: number }
  | { kind: 'cancelled'; iterations: number };

const DEFAULT_COOLDOWN_MS = 5_000;

export async function runTakeOverFlow(input: TakeOverFlowInput): Promise<TakeOverResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const sleep = input.sleep ?? defaultSleep;
  const runCmd = input.runCmd ?? defaultRunCmd;
  const log = input.logger;

  // Hoisted so the post-loop merge can report how many iterations actually ran: on an
  // early `break` it holds the break index, on natural exhaustion it equals maxIterations.
  let iteration = 0;
  // Every cancellation exit reports the iteration it stopped at; `iteration` is read at call time.
  const cancelled = (): TakeOverResult => {
    log?.info('take-over: cancelled', { pr: input.pr, iteration });
    return { kind: 'cancelled', iterations: iteration };
  };
  // Fire the review-bot grace exactly once, the first time CI comes back green.
  let reviewGraceDone = false;
  // The CI-fix Worker's manifest conversation, retained across fix passes so the next one continues
  // where the last left off instead of cold-starting (#107). Same role as run-loop-adapter's
  // ciFixHandles map — a take-over drives a single PR, so one handle suffices.
  let ciFixHandle: SubagentHandle<WorkerTools> | undefined;
  for (; iteration < maxIterations; iteration++) {
    if (input.signal?.aborted) return cancelled();

    // Run-level cost/token ceiling (issue #190): consult the live usage ledger BEFORE this
    // iteration's CI-fix/Reviewer work can spend anything further. A crossed ceiling blocks the run
    // here rather than mid-fix-session.
    if (input.budget) {
      const status = await input.budget();
      // A SIGINT during the async ledger lookup must still report cancelled (exit 2), not a budget
      // block — mirror WorkLoop's post-check re-check of signal.
      if (input.signal?.aborted) return cancelled();
      if (status.exceeded) {
        return { kind: 'blocked', reason: status.reason, iterations: iteration };
      }
    }

    log?.info('take-over: iteration start', { pr: input.pr, iteration });

    // 1. Wait for CI to settle. observeCheckStatus maps a CI failure (or a poll timeout) to
    //    'failure' so the loop treats it as "Worker should try to fix" rather than a fatal error.
    const ciStatus = await observeCheckStatus(input.github, input.pr, input.signal);
    // A cancelled poll returns 'pending', not a verdict — everything below (the fix Worker, the
    // Reviewer, the force-push) would be work on a run the operator already stopped.
    if (input.signal?.aborted) return cancelled();
    log?.info('take-over: ci status', { pr: input.pr, ciStatus });

    // A 'pending' result outside of an abort (waitForChecks only ever returns it on a cancelled
    // poll) is a race between the abort check above and the signal firing — treat it as "CI hasn't
    // settled yet" and retry next iteration rather than falling through to the Reviewer/merge logic
    // below on a non-verdict.
    if (ciStatus === 'pending') {
      if (cooldownMs > 0) await sleep(cooldownMs, input.signal);
      continue;
    }

    // 1a. Review bots (CodeRabbit) post their comments a little *after* CI completes rather than
    //     as a blocking status check. The first time CI is green, wait a grace window before
    //     reading the threads below, so a late-posted review isn't missed and merged past.
    if (ciStatus === 'success' && !reviewGraceDone) {
      reviewGraceDone = true;
      log?.info('take-over: grace for review bots to post comments', {
        pr: input.pr,
        graceMs: REVIEW_COMMENTS_GRACE,
      });
      await sleep(REVIEW_COMMENTS_GRACE, input.signal);
      if (input.signal?.aborted) return cancelled();
    }

    // 2. Pull the not-yet-addressed review threads for the happy-path merge check below and the
    //    green-CI Reviewer pass. freshThreads subtracts threads the Reviewer already ran over (even
    //    if GitHub still shows them unresolved) so a reply-only thread doesn't loop forever.
    //    (On the CI-red path the shared fix session re-reads and addresses the comments itself.)
    const threads = await freshThreads(input, input.pr);
    log?.info('take-over: threads', { pr: input.pr, count: threads.length });

    if (ciStatus === 'success' && threads.length === 0) {
      // Happy path: nothing left to do. Merge.
      break;
    }

    // 3. CI red → the one shared CI-fix session (ci-fix.ts's runFixSession): clear stale context,
    //    download the full failed-CI logs + review comments, run the coding-tier Worker against them
    //    (compaction, memory-index, and the 'no-changes' guard all included), then rebase onto
    //    origin/<base> and force-with-lease push so CI re-runs. The identical pipeline to the
    //    WorkLoop ci-failed stage. It downloads and pushes internally, so loop straight back to
    //    re-poll CI; the Reviewer addresses threads on a later green pass.
    if (ciStatus === 'failure') {
      const fixed = await runCiFixSession(input, runCmd, ciFixHandle);
      // Anything but a delivered fix ends the run: runFixSession already blocks a 'no-changes' or
      // errored Worker on its own reason (a contradiction while CI is red) and never force-pushes
      // zero commits — so a red PR can't burn iterations re-polling the same failing checks.
      if (fixed.kind !== 'fixed') {
        return { kind: 'blocked', reason: fixed.reason, iterations: iteration };
      }
      // Retain this pass's manifest conversation so the next fix pass continues it (#107).
      ciFixHandle = fixed.handle;
      // A push just landed a new commit — CI is about to restart and any review bot comments
      // already seen were against the old head. Re-arm the grace so the next green CI waits again.
      reviewGraceDone = false;
      if (cooldownMs > 0) await sleep(cooldownMs, input.signal);
      continue;
    }

    // 4. CI green with unresolved threads → run the Reviewer, then push its commits.
    let pushedSomething = false;
    // A reviewer error is terminal for this run, but deferred until after the shared push below so a
    // pass that errored mid-way still lands the threads it finished (see the reviewer block).
    let reviewerBlock: string | null = null;

    if (threads.length > 0) {
      const reviewed = await runReviewerThreads(input, threads);
      if (reviewed.kind === 'blocked') {
        return { kind: 'blocked', reason: reviewed.reason, iterations: iteration };
      }
      // A mid-pass reviewer error is terminal, but the threads it finished before throwing were
      // already replied/resolved on GitHub and committed locally. Defer the block until AFTER the
      // shared push below so those completed fixes reach the remote — otherwise the commits sit
      // unpushed while their threads read resolved, and a resume neither replays them (GitHub shows
      // them done) nor re-pushes them, silently dropping the work (durability #4).
      if (reviewed.kind === 'error') {
        reviewerBlock = `reviewer error: ${reviewed.error}`;
      }
      // Record every thread the Reviewer ran over as addressed — including replied/wontfix ones —
      // so waiting-reviews-style re-polls never re-feed a thread GitHub still shows unresolved.
      if (reviewed.resolutions.length > 0) {
        await input.prContext.recordAddressedThreads(
          input.pr,
          reviewed.resolutions.map((r) => r.threadId),
        );
      }
      // Reviewer commits per-thread fixes via the bash tool; we still need to push them — including
      // the ones an errored pass completed before it threw.
      if (reviewed.resolutions.some((r) => r.kind === 'fixed')) {
        pushedSomething = true;
      }
    }

    if (pushedSomething) {
      // The one push path, shared with the ci-fix session: rebase onto origin/<base> then
      // `git push --force-with-lease`. A rebase conflict is handed to the AI resolver (when wired)
      // and retried; only an unresolvable one aborts the rebase and blocks the run cleanly (exit 1).
      const pushed = await rebaseAndForcePush(
        runCmd,
        input.checkoutPath,
        input.baseBranch,
        input.pr,
        log,
        input.allowForcePush ?? true,
        input.subagents.resolveConflicts,
        input.signal,
      );
      if (pushed.kind === 'blocked') {
        return { kind: 'blocked', reason: pushed.reason, iterations: iteration };
      }
      // A push just landed new commits — re-arm the grace so the next green CI waits for review
      // bots again instead of trusting the wait that already happened against the old head.
      reviewGraceDone = false;
    }

    // A deferred reviewer error is now surfaced — after its completed fixes were pushed above.
    if (reviewerBlock !== null) {
      return { kind: 'blocked', reason: reviewerBlock, iterations: iteration };
    }

    // Sleep so the next iteration's waitForChecks sees fresh CI state, not the stale
    // success/failure from before our push triggered a new run.
    if (cooldownMs > 0) await sleep(cooldownMs, input.signal);
  }

  if (input.signal?.aborted) return cancelled();

  // Final state check — make sure we didn't fall through the loop with a hung iteration.
  const finalStatus = await observeCheckStatus(input.github, input.pr, input.signal);
  const finalThreads = await freshThreads(input, input.pr);
  // A cancel during that final wait must not read as "CI never went green" — report the run
  // cancelled (exit 2) rather than blocked (exit 1), and never reach the merge below.
  if (input.signal?.aborted) return cancelled();
  // `iteration` reflects however many iterations actually ran — equal to maxIterations on natural
  // exhaustion, but possibly less when the loop broke early (happy path) and this final check then
  // finds CI or threads regressed before the report below could reflect that race honestly.
  if (finalStatus !== 'success') {
    return {
      kind: 'blocked',
      reason: `CI ${finalStatus} after ${iteration} iteration(s). Inspect the PR and re-run.`,
      iterations: iteration,
    };
  }
  if (finalThreads.length > 0) {
    return {
      kind: 'blocked',
      reason: `${finalThreads.length} unresolved thread(s) after ${iteration} iteration(s).`,
      iterations: iteration,
    };
  }

  await input.github.mergePr(input.pr, input.mergeMethod, { admin: input.adminMerge ?? false });
  log?.info('take-over: merged', { pr: input.pr });
  return { kind: 'merged', pr: input.pr, iterations: iteration };
}

// Flatten waitForChecks' structured result (and its timeout throw) into the single CiState the loop
// branches on: a returned 'failure' state or a CiFailed timeout both surface as 'failure'
// (recoverable — the Worker tries to fix); 'success'/'pending' pass through unchanged.
async function observeCheckStatus(
  github: TakeOverGithub,
  pr: number,
  signal: AbortSignal | undefined,
): Promise<CiState> {
  try {
    const { state } = await github.waitForChecks(pr, signal);
    return state;
  } catch (err) {
    if (err instanceof CiFailed) return 'failure';
    throw err;
  }
}

// Unresolved threads the take-over loop hasn't run the Reviewer over yet: listUnresolvedThreads
// minus the addressed set minus threads that already carry a reply from us. Without this dedup a
// thread the Reviewer only replied to (leaving it unresolved by design, or resolved-but-not-yet-
// reflected by GitHub) would be re-fed to the Reviewer on every iteration. Mirrors stage-handlers.ts's
// freshThreads for the stage-machine PR loop.
async function freshThreads(input: TakeOverFlowInput, pr: number): Promise<ReviewThread[]> {
  const unresolved = await input.github.listUnresolvedThreads(pr);
  const addressed = await input.prContext.readAddressedThreads(pr);
  const botLogin = await botReplyLogin(input.github);
  return unresolved.filter((t) => !addressed.has(t.id) && !hasReplyFrom(t, botLogin));
}

// The login `gh` is authenticated as, or undefined when it can't be resolved. Best-effort: the
// bot-reply skip is an enhancement over the addressed-set dedup, so a gh hiccup degrades to that
// record rather than breaking the review loop.
async function botReplyLogin(github: TakeOverGithub): Promise<string | undefined> {
  try {
    return await github.authenticatedLogin?.();
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

async function runReviewerThreads(
  input: TakeOverFlowInput,
  threads: ReviewThread[],
): Promise<ReviewerResult> {
  // The advisory date context block the main-loop Reviewer gets (issue #106/#141), threaded into the
  // reviewer's first user message. Built once so the override stand-in and the real runReviewer call
  // receive the identical block.
  const contextBlock = harnessContextBlock();
  if (input.subagents.runReviewerOverride) {
    return input.subagents.runReviewerOverride({
      pr: input.pr,
      threads,
      checkoutPath: input.checkoutPath,
      styleContents: input.subagents.styleContents,
      contextBlock,
    });
  }
  const agent = createReviewerAgent({
    model: input.subagents.reviewerModel,
    tools: input.subagents.reviewerTools,
    // reminderAgentSystemPrompt (not bare buildRolePrompt): the take-over Reviewer runs on the same
    // reminder-decorated worker tool set (merge-flow-adapter → resolveWorkerTools), so its prompt
    // must carry the #106 provenance contract too (issue #141).
    systemPrompt: reminderAgentSystemPrompt({
      style: input.subagents.styleContents,
      roleGuidance: REVIEWER_SYSTEM_PREFIX,
      cwd: input.checkoutPath,
    }),
    ...(input.subagents.timeout !== undefined ? { timeout: input.subagents.timeout } : {}),
    ...(input.subagents.onReviewerStepFinish
      ? { onStepFinish: input.subagents.onReviewerStepFinish }
      : {}),
    ...(input.subagents.onReviewerUsage ? { onUsage: input.subagents.onReviewerUsage } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return runReviewer(agent, {
    pr: input.pr,
    threads,
    checkoutPath: input.checkoutPath,
    styleContents: input.subagents.styleContents,
    contextBlock,
  });
}

// CI-fix path, delegated to the one shared session (ci-fix.ts's runFixSession) so `aitm merge-pr`
// and `aitm start` fix a red PR identically. Builds a minimal PR group whose only carried state is
// branch/PR context — runFixSession's buildFixTask supplies the single scoped fix task — and maps
// the take-over subagent seams onto FixSessionSubagents. `priorHandle` continues the previous fix
// pass's manifest conversation (#107).
function runCiFixSession(
  input: TakeOverFlowInput,
  runCmd: RunCmd,
  priorHandle: SubagentHandle<WorkerTools> | undefined,
): Promise<FixSessionResult> {
  const { subagents } = input;
  const group: PrGroup = {
    id: `takeover-ci-${input.pr}`,
    title: `Fix CI failures on PR #${input.pr}`,
    // buildFixTask supplies the scoped fix task; the group only carries branch/PR context.
    tasks: [],
    dependsOn: [],
    branch: null,
    pr: input.pr,
    status: 'in-progress',
    stage: 'ci-failed',
    reviewGraceApplied: false,
  };
  return runFixSession({
    github: input.github,
    prContext: input.prContext,
    subagents: {
      credentials: subagents.credentials,
      workerTools: subagents.workerTools,
      styleContents: subagents.styleContents,
      ...(subagents.formatCommand ? { formatCommand: subagents.formatCommand } : {}),
      ...(subagents.verifyCommand ? { verifyCommand: subagents.verifyCommand } : {}),
      ...(subagents.timeout !== undefined ? { timeout: subagents.timeout } : {}),
      ...(subagents.onWorkerUsage ? { onUsage: subagents.onWorkerUsage } : {}),
      ...(subagents.onWorkerStepFinish ? { onStepFinish: subagents.onWorkerStepFinish } : {}),
      ...(subagents.onEditorStepFinish ? { onEditorStepFinish: subagents.onEditorStepFinish } : {}),
      ...(subagents.runWorkerOverride ? { runWorkerOverride: subagents.runWorkerOverride } : {}),
      ...(subagents.resolveConflicts ? { resolveConflicts: subagents.resolveConflicts } : {}),
    },
    group,
    pr: input.pr,
    baseBranch: input.baseBranch,
    checkoutPath: input.checkoutPath,
    runCmd,
    allowForcePush: input.allowForcePush ?? true,
    ...(input.logger ? { logger: input.logger } : {}),
    ...(priorHandle ? { priorHandle } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

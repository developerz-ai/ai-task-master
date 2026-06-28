// Take-over merge flow. Drives an externally-built PR (Claude Code, gh pr create, etc.)
// to merge: waits for CI, runs Reviewer to address unresolved review threads (CodeRabbit
// + human reviewers), pushes fixes, and merges. Mirrors the claude-task-master
// `merge_pr()` shape from src/claude_task_master/cli_commands/fix_pr.py:
//
//   for iteration in 0..maxIterations:
//     status   = waitForChecks(pr)
//     threads  = listUnresolvedThreads(pr)
//     if status == success and threads.empty: break
//     if status == failure: runWorker (CI-fix path, optional)
//     if threads.any: runReviewer per thread, push commits
//     sleep(cooldown)  # let CI restart
//   mergePr(pr)
//
// Unlike WorkLoop.autoMergeFlow, this does NOT acquire a `git worktree`. The user is
// expected to be on the PR branch in their cwd; everything happens in-place. That's
// the simpler model and matches how a human reviewer would handle it.
//
// docs/vendor/ai-sdk/chunk-09.md §"Subagents" — Reviewer/Worker are built ad-hoc per loop
// iteration because their tool bindings (worktree, threads) change each iteration.

import { composeSystemPrompt } from '@developerz.ai/ai-claude-compat';
import type { LanguageModel } from 'ai';
import { CiFailed } from '../github/errors.ts';
import type { CiResult, MergeMethod } from '../github/github-client.ts';
import type { CheckStatus, ReviewThread } from '../github/schema.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { PrGroup } from '../state/schema.ts';
import {
  createReviewerAgent,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerResult,
  type ReviewerTools,
  runReviewer,
} from '../subagents/reviewer.ts';
import {
  createWorkerAgent,
  runWorker,
  WORKER_SYSTEM_PREFIX,
  type WorkerResult,
  type WorkerTools,
} from '../subagents/worker.ts';

// Minimal slice of GitHubClient used by the flow. Structural so tests can stub it.
export type TakeOverGithub = {
  waitForChecks(pr: number): Promise<CiResult>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number, method: MergeMethod): Promise<void>;
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
  // Optional — present on the real GitHubClient. When available, the flow downloads the full
  // failed-CI logs so the CI-fix Worker can read them off disk instead of guessing (issue #48).
  getFailedCiLogs?(pr: number): Promise<Array<{ check: string; logs: string }>>;
};

// Persists downloaded PR context (CI logs / comments) to disk under the state dir. PrContextStore
// satisfies this; tests pass a stub. Optional on the flow input — when omitted, nothing is
// downloaded and the CI-fix Worker falls back to its generic "read the CI logs via gh" task.
export type PrContextPort = {
  clear(pr: number): Promise<void>;
  saveCiFailures(
    pr: number,
    failures: ReadonlyArray<{ check: string; logs: string }>,
  ): Promise<string | null>;
  saveComments(pr: number, threads: readonly ReviewThread[]): Promise<string | null>;
};

// Subagent factories injected so tests can swap them for stubs without touching the AI SDK.
// Production passes the real factories: createReviewerAgent + runReviewer, etc.
export type TakeOverSubagents = {
  reviewerModel: LanguageModel;
  reviewerTools: ReviewerTools;
  workerModel: LanguageModel;
  workerTools: WorkerTools;
  // Style payload (CLAUDE.md / AGENTS.md). Prepended to subagent system prompts.
  styleContents: string;
  // Optional formatter command the CI-fix Worker runs before committing (issue #48).
  formatCommand?: string;
  // Injection seam — bypass the real subagent agents in tests.
  runReviewerOverride?: (input: {
    pr: number;
    threads: ReviewThread[];
    worktreePath: string;
    styleContents: string;
  }) => Promise<ReviewerResult>;
  runWorkerOverride?: (input: {
    group: PrGroup;
    worktreePath: string;
    baseBranch: string;
    styleContents: string;
    rollingContext: string;
  }) => Promise<WorkerResult>;
};

export type TakeOverFlowInput = {
  pr: number;
  worktreePath: string;
  baseBranch: string;
  github: TakeOverGithub;
  subagents: TakeOverSubagents;
  // Optional store for downloaded CI logs / comments (issue #48). When present, the flow writes
  // full failed-CI logs under .ai-task-master/debugging/pr/<pr>/ and points the Worker at them.
  prContext?: PrContextPort;
  mergeMethod: MergeMethod;
  // Cap on iterations of the CI-wait/fix loop. Default 10 — claude-task-master uses 30 but
  // each iteration here is heavier (model calls per thread), so default lower.
  maxIterations?: number;
  // Sleep between iterations so the next `waitForChecks` actually sees fresh CI state
  // after a push. Default 5s. Tests inject a 0-ms sleep.
  cooldownMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // Optional: bash callback to run `git push` after Reviewer/Worker commits. Defaults
  // to a real git push via execa (in adapter wiring). Stubbed in unit tests.
  push: (worktreePath: string) => Promise<void>;
  logger?: LoggerLike;
};

export type TakeOverResult =
  | { kind: 'merged'; pr: number; iterations: number }
  | { kind: 'blocked'; reason: string; iterations: number };

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_COOLDOWN_MS = 5_000;

export async function runTakeOverFlow(input: TakeOverFlowInput): Promise<TakeOverResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const sleep = input.sleep ?? defaultSleep;
  const log = input.logger;

  // Hoisted so the post-loop merge can report how many iterations actually ran: on an
  // early `break` it holds the break index, on natural exhaustion it equals maxIterations.
  let iteration = 0;
  for (; iteration < maxIterations; iteration++) {
    log?.info('take-over: iteration start', { pr: input.pr, iteration });

    // 1. Wait for CI to settle. observeCheckStatus maps a CI failure (or a poll timeout) to
    //    'failure' so the loop treats it as "Worker should try to fix" rather than a fatal error.
    const ciStatus = await observeCheckStatus(input.github, input.pr);
    log?.info('take-over: ci status', { pr: input.pr, ciStatus });

    // 2. Pull review threads. Always runs — even on CI failure, threads may exist and
    //    fixing them might happen to fix CI too.
    const threads = await input.github.listUnresolvedThreads(input.pr);
    log?.info('take-over: threads', { pr: input.pr, count: threads.length });

    if (ciStatus === 'success' && threads.length === 0) {
      // Happy path: nothing left to do. Merge.
      break;
    }

    // 3. Download context to disk so subagents can READ it instead of guessing: full failed-CI
    //    logs (one file per check) + the review comments, under .ai-task-master/debugging/pr/<pr>/.
    //    Re-downloaded each iteration so the Worker never reads stale logs from a prior push.
    let ciLogsDir: string | null = null;
    if (input.prContext) {
      await input.prContext.clear(input.pr);
      if ((ciStatus === 'failure' || ciStatus === 'cancelled') && input.github.getFailedCiLogs) {
        const failures = await input.github.getFailedCiLogs(input.pr);
        ciLogsDir = await input.prContext.saveCiFailures(input.pr, failures);
        log?.info('take-over: downloaded ci logs', {
          pr: input.pr,
          checks: failures.length,
          dir: ciLogsDir,
        });
      }
      if (threads.length > 0) await input.prContext.saveComments(input.pr, threads);
    }

    let pushedSomething = false;

    if (ciStatus === 'failure' || ciStatus === 'cancelled') {
      const fixed = await runWorkerCiFix(input, ciLogsDir);
      if (fixed.kind === 'blocked') {
        return { kind: 'blocked', reason: fixed.reason, iterations: iteration };
      }
      if (fixed.kind === 'error') {
        return { kind: 'blocked', reason: `worker error: ${fixed.error}`, iterations: iteration };
      }
      pushedSomething = true;
    }

    if (threads.length > 0) {
      const reviewed = await runReviewerThreads(input, threads);
      if (reviewed.kind === 'blocked') {
        return { kind: 'blocked', reason: reviewed.reason, iterations: iteration };
      }
      if (reviewed.kind === 'error') {
        return {
          kind: 'blocked',
          reason: `reviewer error: ${reviewed.error}`,
          iterations: iteration,
        };
      }
      // Reviewer commits per-thread fixes via the bash tool; we still need to push them.
      if (reviewed.resolutions.some((r) => r.kind === 'fixed')) {
        pushedSomething = true;
      }
    }

    if (pushedSomething) {
      await input.push(input.worktreePath);
      log?.info('take-over: pushed fixes', { pr: input.pr });
    }

    // Sleep so the next iteration's waitForChecks sees fresh CI state, not the stale
    // success/failure from before our push triggered a new run.
    if (cooldownMs > 0) await sleep(cooldownMs);
  }

  // Final state check — make sure we didn't fall through the loop with a hung iteration.
  const finalStatus = await observeCheckStatus(input.github, input.pr);
  const finalThreads = await input.github.listUnresolvedThreads(input.pr);
  if (finalStatus !== 'success') {
    return {
      kind: 'blocked',
      reason: `CI ${finalStatus} after ${maxIterations} iteration(s). Inspect the PR and re-run.`,
      iterations: maxIterations,
    };
  }
  if (finalThreads.length > 0) {
    return {
      kind: 'blocked',
      reason: `${finalThreads.length} unresolved thread(s) after ${maxIterations} iteration(s).`,
      iterations: maxIterations,
    };
  }

  await input.github.mergePr(input.pr, input.mergeMethod);
  log?.info('take-over: merged', { pr: input.pr });
  return { kind: 'merged', pr: input.pr, iterations: iteration };
}

// Flatten waitForChecks' structured result (and its timeout throw) into a single CheckStatus the
// loop branches on: a returned 'failure' state or a CiFailed timeout both surface as 'failure'
// (recoverable — the Worker tries to fix); 'success'/'pending' pass through unchanged.
async function observeCheckStatus(github: TakeOverGithub, pr: number): Promise<CheckStatus> {
  try {
    const { state } = await github.waitForChecks(pr);
    return state;
  } catch (err) {
    if (err instanceof CiFailed) return 'failure';
    throw err;
  }
}

async function runReviewerThreads(
  input: TakeOverFlowInput,
  threads: ReviewThread[],
): Promise<ReviewerResult> {
  if (input.subagents.runReviewerOverride) {
    return input.subagents.runReviewerOverride({
      pr: input.pr,
      threads,
      worktreePath: input.worktreePath,
      styleContents: input.subagents.styleContents,
    });
  }
  const agent = createReviewerAgent({
    model: input.subagents.reviewerModel,
    tools: input.subagents.reviewerTools,
    systemPrompt: composeSystemPrompt(
      input.subagents.styleContents,
      REVIEWER_SYSTEM_PREFIX,
      input.worktreePath,
    ),
  });
  return runReviewer(agent, {
    pr: input.pr,
    threads,
    worktreePath: input.worktreePath,
    styleContents: input.subagents.styleContents,
  });
}

// Worker CI-fix path. Build a synthetic PR group whose only task is "fix CI on this PR",
// then run the regular Worker. Worker emits a FileManifest and runs per-file editors —
// suitable for "test failed, fix it" if Worker has enough context from the worktree.
async function runWorkerCiFix(
  input: TakeOverFlowInput,
  ciLogsDir: string | null,
): Promise<WorkerResult> {
  // When the logs were downloaded, point the Worker at the exact files (full logs, one per failed
  // check) so a weak model has concrete errors to act on instead of being told to run `gh` itself.
  const readTask = ciLogsDir
    ? `Read the downloaded CI failure logs in ${ciLogsDir} (one file per failed check, full untruncated logs) with your shell/read tools, then fix every failure those logs report.`
    : `Read the CI logs (via gh) and fix every failing check on PR #${input.pr}.`;
  const group: PrGroup = {
    id: `takeover-ci-${input.pr}`,
    title: `Fix CI failures on PR #${input.pr}`,
    tasks: [
      { id: `takeover-ci-${input.pr}-1`, text: readTask, complexity: 'normal', done: false },
      {
        id: `takeover-ci-${input.pr}-2`,
        text: 'Run the project test/lint commands locally to verify, then stage fixes.',
        complexity: 'normal',
        done: false,
      },
    ],
    dependsOn: [],
    branch: null,
    pr: input.pr,
    status: 'in-progress',
    stage: 'waiting-ci',
  };
  if (input.subagents.runWorkerOverride) {
    return input.subagents.runWorkerOverride({
      group,
      worktreePath: input.worktreePath,
      baseBranch: input.baseBranch,
      styleContents: input.subagents.styleContents,
      rollingContext: '',
    });
  }
  const agent = createWorkerAgent({
    model: input.subagents.workerModel,
    tools: input.subagents.workerTools,
    systemPrompt: composeSystemPrompt(
      input.subagents.styleContents,
      WORKER_SYSTEM_PREFIX,
      input.worktreePath,
    ),
  });
  return runWorker(agent, {
    group,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
    styleContents: input.subagents.styleContents,
    rollingContext: '',
    ...(input.subagents.formatCommand ? { formatCommand: input.subagents.formatCommand } : {}),
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

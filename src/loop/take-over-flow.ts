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

import type { LanguageModel } from 'ai';
import { CiFailed } from '../github/errors.ts';
import type { MergeMethod } from '../github/github-client.ts';
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
  waitForChecks(pr: number): Promise<CheckStatus>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
  mergePr(pr: number, method: MergeMethod): Promise<void>;
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
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

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    log?.info('take-over: iteration start', { pr: input.pr, iteration });

    // 1. Wait for CI to settle. waitForChecks throws CiFailed on hard failure; we treat
    //    that as "Worker should try to fix" rather than a fatal error.
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

    let pushedSomething = false;

    if (ciStatus === 'failure' || ciStatus === 'cancelled') {
      const fixed = await runWorkerCiFix(input);
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
  return { kind: 'merged', pr: input.pr, iterations: maxIterations };
}

// Convert waitForChecks' throw-on-failure semantics into a status return so the loop can
// treat CI failure as a recoverable state.
async function observeCheckStatus(github: TakeOverGithub, pr: number): Promise<CheckStatus> {
  try {
    return await github.waitForChecks(pr);
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
    systemPrompt: input.subagents.styleContents + REVIEWER_SYSTEM_PREFIX,
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
async function runWorkerCiFix(input: TakeOverFlowInput): Promise<WorkerResult> {
  const group: PrGroup = {
    id: `takeover-ci-${input.pr}`,
    title: `Fix CI failures on PR #${input.pr}`,
    tasks: [
      `Read the CI logs (via gh) and fix every failing check on PR #${input.pr}.`,
      'Run the project test/lint commands locally to verify, then stage fixes.',
    ],
    dependsOn: [],
    branch: null,
    pr: input.pr,
    status: 'in-progress',
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
    systemPrompt: input.subagents.styleContents + WORKER_SYSTEM_PREFIX,
  });
  return runWorker(agent, {
    group,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
    styleContents: input.subagents.styleContents,
    rollingContext: '',
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

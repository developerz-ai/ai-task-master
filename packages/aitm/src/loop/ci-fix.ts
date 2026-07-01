// Shared CI-fix session: download → fix → rebase → force-with-lease. One self-contained pass,
// reused by the `ci-failed` stage handler (WorkLoop) and the `merge-pr` take-over loop so both
// fix a red PR the same way. Mirrors claude-task-master's fix_session.py / handle_ci_failed_stage.
//
// One session does exactly this, in order:
//   1. Download fresh context — clear any stale dump, then pull the FULL failed-CI logs
//      (getFailedCiLogs) + the unresolved review threads (listUnresolvedThreads) and persist them
//      under .ai-task-master/debugging/pr/<pr>/{ci,comments}/ so the Worker READS them off disk
//      instead of being handed a giant prompt.
//   2. Run the Worker on the group's branch, pointed at those dirs, to fix every CI failure and
//      address every review comment that needs a code change. Always the coding-capability model
//      (modelForCapability('coding')) — the strongest code model, never hardcoded.
//   3. Rebase onto origin/<base> and `git push --force-with-lease` (never plain --force; rebase
//      before every push) so the PR re-runs CI on top of the latest base.
//
// SRP: this is one fix pass — no polling, no iteration cap, no merge. Callers own the wait/re-poll
// loop and decide what to do with the result (advance to waiting-ci, or block).

import { composeSystemPrompt } from '@developerz.ai/ai-claude-compat';
import type { LanguageModel } from 'ai';
import type { Capability } from '../config/schema.ts';
import { defaultRunCmd, type RunCmd, type RunCmdResult } from '../github/github-client.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { PrGroup, Task } from '../state/schema.ts';
import {
  createWorkerAgent,
  runWorker,
  WORKER_SYSTEM_PREFIX,
  type WorkerInput,
  type WorkerResult,
  type WorkerTools,
} from '../subagents/worker.ts';

// Narrow structural slice of GitHubClient the session reads. Structural so tests stub it without
// the full client. Both methods exist on the real GitHubClient.
export type FixSessionGithub = {
  getFailedCiLogs(pr: number): Promise<Array<{ check: string; logs: string }>>;
  listUnresolvedThreads(pr: number): Promise<ReviewThread[]>;
};

// Persists the downloaded context to disk. PrContextStore satisfies this. saveCiFailures /
// saveComments return the directory they wrote to (or null when there was nothing) — the Worker
// prompt points at exactly those dirs.
export type FixSessionPrContext = {
  clear(pr: number): Promise<void>;
  saveCiFailures(
    pr: number,
    failures: ReadonlyArray<{ check: string; logs: string }>,
  ): Promise<string | null>;
  saveComments(pr: number, threads: readonly ReviewThread[]): Promise<string | null>;
};

// Model selector — Credentials satisfies it structurally. The session owns the tier decision:
// always 'coding', so a CI fix lands on the strongest code model regardless of role mapping.
export type FixSessionModelSelector = {
  modelForCapability(capability: Capability): LanguageModel;
};

export type FixSessionSubagents = {
  credentials: FixSessionModelSelector;
  workerTools: WorkerTools;
  // Style payload (CLAUDE.md / AGENTS.md digest). Prepended to the Worker system prompt.
  styleContents: string;
  // Optional formatter command the Worker runs before committing, so the diff matches the
  // project's formatter (issue #48).
  formatCommand?: string;
  // Injection seam — bypass the real Worker agent in tests.
  runWorkerOverride?: (input: WorkerInput) => Promise<WorkerResult>;
};

export type FixSessionInput = {
  github: FixSessionGithub;
  prContext: FixSessionPrContext;
  subagents: FixSessionSubagents;
  group: PrGroup;
  pr: number;
  baseBranch: string;
  // Where the group's branch is checked out — the Worker edits here and all git runs with this cwd.
  worktreePath: string;
  // git/gh shim — defaults to execa. Stubbed in unit tests to assert command shape (fetch/rebase/
  // push --force-with-lease) without spawning processes.
  runCmd?: RunCmd;
  // Force-push policy (from config allowForcePush). Default true. When false, the CI-fix rebase+
  // force-with-lease push is refused and the session blocks instead of pushing.
  allowForcePush?: boolean;
  logger?: LoggerLike;
};

export type FixSessionResult =
  | { kind: 'fixed' } // Worker committed a fix; rebased + force-pushed. CI will re-run.
  | { kind: 'blocked'; reason: string }; // Worker couldn't fix, or rebase/push failed.

export async function runFixSession(input: FixSessionInput): Promise<FixSessionResult> {
  const { github, prContext, group, pr, baseBranch, worktreePath } = input;
  const runCmd = input.runCmd ?? defaultRunCmd;
  const log = input.logger;

  // 1. Fresh context only: drop any stale dump from a prior push, then download logs + comments.
  await prContext.clear(pr);
  const failures = await github.getFailedCiLogs(pr);
  const threads = await github.listUnresolvedThreads(pr);
  const ciDir = await prContext.saveCiFailures(pr, failures);
  const commentsDir = await prContext.saveComments(pr, threads);
  log?.info('ci-fix: downloaded context', {
    pr,
    checks: failures.length,
    threads: threads.length,
    ciDir,
    commentsDir,
  });

  // 2. Worker fix pass, pointed at the downloaded dirs.
  const worker = await runFixWorker(input, buildFixTask(group, pr, ciDir, commentsDir));
  if (worker.kind !== 'ok') {
    const reason =
      worker.kind === 'blocked' ? worker.reason : `worker error during CI fix: ${worker.error}`;
    log?.warn('ci-fix: worker did not deliver a fix', { pr, reason });
    return { kind: 'blocked', reason };
  }

  // 3. Rebase onto the latest base, then force-with-lease push so CI re-runs on fresh ground.
  return rebaseAndForcePush(
    runCmd,
    worktreePath,
    baseBranch,
    pr,
    log,
    input.allowForcePush ?? true,
  );
}

// The fix task: read the on-disk context (when present), fix every failure, verify locally. Scoped
// as a single `task` so the Worker's manifest prompt targets the fix instead of re-planning the
// group's original work; the group is still passed so the commit lands on its branch.
function buildFixTask(
  group: PrGroup,
  pr: number,
  ciDir: string | null,
  commentsDir: string | null,
): Task {
  const sources: string[] = [];
  if (ciDir) {
    sources.push(
      `  - CI failure logs (one file per failed check, full untruncated logs): ${ciDir}`,
    );
  }
  if (commentsDir) {
    sources.push(`  - Unresolved review comments (one file per thread): ${commentsDir}`);
  }
  const read =
    sources.length > 0
      ? ['Read the downloaded PR context with your shell/read tools:', ...sources].join('\n')
      : `Inspect the failing checks and unresolved review comments on PR #${pr} via gh.`;
  const text = [
    read,
    '',
    'Fix EVERY CI failure those logs report, and address every review comment that needs a code',
    'change. Run the project test/lint commands locally to verify before staging.',
  ].join('\n');
  return { id: `${group.id}-ci-fix`, text, complexity: 'complex', done: false };
}

async function runFixWorker(input: FixSessionInput, task: Task): Promise<WorkerResult> {
  const { subagents, group, baseBranch, worktreePath } = input;
  const workerInput: WorkerInput = {
    group,
    task,
    worktreePath,
    baseBranch,
    styleContents: subagents.styleContents,
    rollingContext: '',
    ...(subagents.formatCommand ? { formatCommand: subagents.formatCommand } : {}),
  };
  if (subagents.runWorkerOverride) return subagents.runWorkerOverride(workerInput);
  const agent = createWorkerAgent({
    model: subagents.credentials.modelForCapability('coding'),
    tools: subagents.workerTools,
    systemPrompt: composeSystemPrompt(subagents.styleContents, WORKER_SYSTEM_PREFIX, worktreePath),
  });
  return runWorker(agent, workerInput);
}

// The one push path for the whole repo: rebase onto origin/<base>, then `git push --force-with-lease`
// (never plain `git push`, which fails against a rebased remote; never plain `--force`). On a rebase
// conflict it aborts the half-applied rebase and blocks. Shared by `runFixSession` (WorkLoop) and the
// `merge-pr` take-over loop so every force-push goes through the same rebase-first guard.
export async function rebaseAndForcePush(
  runCmd: RunCmd,
  worktreePath: string,
  baseBranch: string,
  pr: number,
  log: LoggerLike | undefined,
  allowForcePush = true,
): Promise<FixSessionResult> {
  // This is the only force-push path. When policy forbids it, don't rebase — block cleanly so a
  // human lands the fix, rather than leaving a rebased branch that can't be pushed.
  if (!allowForcePush) {
    return {
      kind: 'blocked',
      reason:
        'force-push is disabled by policy (allowForcePush=false); the CI fix cannot be ' +
        'rebased-and-pushed — rebase onto the base and push it manually.',
    };
  }
  const cwd = { cwd: worktreePath };
  const fetch = await runCmd('git', ['fetch', 'origin', baseBranch], cwd);
  if (fetch.exitCode !== 0) {
    return { kind: 'blocked', reason: `git fetch origin ${baseBranch} failed: ${gitErr(fetch)}` };
  }
  const rebase = await runCmd('git', ['rebase', `origin/${baseBranch}`], cwd);
  if (rebase.exitCode !== 0) {
    // Abort the half-applied rebase so the worktree is left clean for a later retry.
    await runCmd('git', ['rebase', '--abort'], cwd);
    return {
      kind: 'blocked',
      reason: `git rebase onto origin/${baseBranch} hit conflicts that need manual resolution: ${gitErr(rebase)}`,
    };
  }
  const push = await runCmd('git', ['push', '--force-with-lease'], cwd);
  if (push.exitCode !== 0) {
    return { kind: 'blocked', reason: `git push --force-with-lease failed: ${gitErr(push)}` };
  }
  log?.info('ci-fix: rebased + force-pushed', { pr, baseBranch });
  return { kind: 'fixed' };
}

function gitErr(r: RunCmdResult): string {
  return r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`;
}

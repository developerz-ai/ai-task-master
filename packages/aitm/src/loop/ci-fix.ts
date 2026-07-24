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

import type { MemoryIndexEntry, SubagentHandle } from '@developerz.ai/ai-claude-compat';
import type { LanguageModel, ModelMessage, TimeoutConfiguration } from 'ai';
import { buildCompactionStep, type CompactorLike } from '../compaction/compaction-step.ts';
import type { Capability } from '../config/schema.ts';
import {
  defaultRunCmd,
  type RunCmd,
  type RunCmdOptions,
  type RunCmdResult,
} from '../github/github-client.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { PrGroup, Task } from '../state/schema.ts';
import type { SubagentInit } from '../subagents/factory.ts';
import { buildRolePrompt } from '../subagents/role-prompt.ts';
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
  clearCi(pr: number): Promise<void>;
  clearComments(pr: number): Promise<void>;
  saveCiFailures(
    pr: number,
    failures: ReadonlyArray<{ check: string; logs: string }>,
  ): Promise<string | null>;
  saveComments(pr: number, threads: readonly ReviewThread[]): Promise<string | null>;
};

// Model selector — Credentials satisfies it structurally. The session owns the tier decision:
// always 'coding', so a CI fix lands on the strongest code model regardless of role mapping. The
// id method feeds the Compactor's context-window lookup for the same tier (issue #102).
export type FixSessionModelSelector = {
  modelForCapability(capability: Capability): LanguageModel;
  modelIdForCapability(capability: Capability): string;
};

export type FixSessionSubagents = {
  credentials: FixSessionModelSelector;
  workerTools: WorkerTools;
  // Style payload (CLAUDE.md / AGENTS.md digest). Prepended to the Worker system prompt.
  styleContents: string;
  // Optional formatter command the Worker runs before committing, so the diff matches the
  // project's formatter (issue #48).
  formatCommand?: string;
  // Optional verify command the Worker runs before staging; a fix session whose worker result
  // still fails verify blocks instead of rebasing and force-pushing a red commit (issue #122).
  verifyCommand?: string;
  // Optional Compactor. When present, the CI-fix Worker gets a prepareStep that summarizes-and-
  // continues when its context window fills, using the 'coding'-tier model id (issue #102).
  compactor?: CompactorLike;
  // Per-step LLM request deadline, forwarded to the CI-fix Worker agent (issue #129). Unset → none.
  timeout?: TimeoutConfiguration;
  // Provider options forwarded to the CI-fix Worker agent — the adapter attaches OpenRouter
  // web_search here by default for fix sessions (issue #112). Unset → none.
  providerOptions?: SubagentInit<WorkerTools>['providerOptions'];
  // Usage sink forwarded to the CI-fix Worker agent, recorded under the worker role (#114). Unset → none.
  onUsage?: SubagentInit<WorkerTools>['onUsage'];
  // Live rolling context — what earlier groups shipped, threaded into the fix Worker's manifest
  // prompt (issue #123). Unset → '' (the render guard makes it a no-op), matching prior behavior.
  rollingContext?: string;
  // Per-repo memory index injected into the fix Worker's prompt (issue #118). Unset → no memory block.
  memoryIndex?: readonly MemoryIndexEntry[];
  // Per-step transcript recorder callback (issue #108), forwarded to the fix Worker agent. Unset →
  // nothing recorded.
  onStepFinish?: SubagentInit<WorkerTools>['onStepFinish'];
  // Progress-only per-step callback for the fix Worker's parallel editor fanout (silent-run fix).
  // See SubagentInit.onEditorStepFinish. Unset → editors stay silent.
  onEditorStepFinish?: SubagentInit<WorkerTools>['onEditorStepFinish'];
  // Retry-visibility sink forwarded to the fix Worker agent (slice 01b). Unset → no sink.
  onRetry?: SubagentInit<WorkerTools>['onRetry'];
  // Live-streaming sink + watchdog overrides forwarded to the fix Worker agent (slice 07). Set only
  // when config `streaming` is true. Unset → non-streaming path, byte-identical to today.
  onStream?: SubagentInit<WorkerTools>['onStream'];
  streamWatchdog?: SubagentInit<WorkerTools>['streamWatchdog'];
  // Reconstructed messages from an interrupted ci-fix transcript (issue #108). When present and no
  // in-memory priorHandle exists, the fix Worker resumes from them instead of cold-starting.
  resumeMessages?: readonly ModelMessage[];
  // Injection seam — bypass the real Worker agent in tests.
  runWorkerOverride?: (input: WorkerInput) => Promise<WorkerResult>;
  // AI rebase-conflict resolver (issue: AI-resolved conflicts). When set, a rebase that hits a
  // content conflict is handed to it — resolve the hunks + `git add` — and the push is retried,
  // instead of aborting and blocking. Unset → today's abort+block. Built by conflict-resolution.ts;
  // stubbed in tests. Gated by config `resolveConflicts` at the adapter (unset here → disabled).
  resolveConflicts?: ConflictResolver;
};

export type FixSessionInput = {
  github: FixSessionGithub;
  prContext: FixSessionPrContext;
  subagents: FixSessionSubagents;
  group: PrGroup;
  pr: number;
  baseBranch: string;
  // Where the group's branch is checked out — the Worker edits here and all git runs with this cwd.
  checkoutPath: string;
  // git/gh shim — defaults to execa. Stubbed in unit tests to assert command shape (fetch/rebase/
  // push --force-with-lease) without spawning processes.
  runCmd?: RunCmd;
  // Force-push policy (from config allowForcePush). Default true. When false, the CI-fix rebase+
  // force-with-lease push is refused and the session blocks instead of pushing.
  allowForcePush?: boolean;
  logger?: LoggerLike;
  // Handle from this group's previous CI-fix pass (#107). When set, the fix Worker continues that
  // manifest-planning conversation — it remembers what earlier passes already tried.
  priorHandle?: SubagentHandle<WorkerTools>;
  // Run-scoped cancellation, forwarded to the fix Worker agent (see SubagentInit.signal) so an abort
  // tears its in-flight generation down. Mirrors TakeOverFlowInput.signal. Unset → no signal.
  signal?: AbortSignal;
};

export type FixSessionResult =
  // `handle` retains the fix Worker's manifest conversation for the next fix pass to continue (#107).
  | { kind: 'fixed'; handle: SubagentHandle<WorkerTools> } // committed + rebased + force-pushed; CI re-runs.
  | { kind: 'blocked'; reason: string }; // Worker couldn't fix, or rebase/push failed.

// The push-path outcome — handle-agnostic, since rebaseAndForcePush is also shared by the take-over
// flow (which retains no conversation). runFixSession attaches the Worker handle to the 'fixed' case.
export type PushResult = { kind: 'fixed' } | { kind: 'blocked'; reason: string };

// One AI conflict-resolution request: the files git left unmerged mid-rebase, plus the base branch
// and the 1-based attempt number. The resolver resolves each file's <<<<<<</=======/>>>>>>> hunks
// (preserving BOTH sides) and `git add`s them — it must NOT run `git rebase --continue`/`--abort`,
// `git commit`, or `git checkout`; rebaseAndForcePush drives the rebase state machine and verifies.
export type ConflictResolutionInput = {
  checkoutPath: string;
  baseBranch: string;
  conflictedFiles: readonly string[];
  attempt: number;
};

// Resolver outcome. `resolved` means the files were edited + staged (rebaseAndForcePush re-checks
// for leftover unmerged paths and drives `git rebase --continue`); `unresolved` blocks the push.
export type ConflictResolution = { kind: 'resolved' } | { kind: 'unresolved'; reason: string };

// The injectable conflict-resolution seam. Production wiring builds one from the Worker model/tools
// (conflict-resolution.ts); tests stub it. Absent on rebaseAndForcePush → today's abort+block.
export type ConflictResolver = (input: ConflictResolutionInput) => Promise<ConflictResolution>;

// Bounded AI resolution attempts before falling back to abort+block. Small on purpose: a genuinely
// tangled conflict should reach a human, not loop the model forever.
export const MAX_CONFLICT_RESOLVE_ATTEMPTS = 2;

export async function runFixSession(input: FixSessionInput): Promise<FixSessionResult> {
  const { github, prContext, group, pr, baseBranch, checkoutPath } = input;
  const runCmd = input.runCmd ?? defaultRunCmd;
  const log = input.logger;

  // 1. Fresh context only: drop the stale ci/ + comments/ dump from a prior push — the addressed-
  //    thread ledger deliberately survives — then download logs + comments.
  await prContext.clearCi(pr);
  await prContext.clearComments(pr);
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
    // 'no-changes' here is a contradiction — CI is red, so claiming nothing needs changing cannot
    // fix it. Surface the worker's own reason and block, same as an explicit block.
    const reason =
      worker.kind === 'error' ? `worker error during CI fix: ${worker.error}` : worker.reason;
    log?.warn('ci-fix: worker did not deliver a fix', { pr, reason });
    return { kind: 'blocked', reason };
  }

  // 3. Rebase onto the latest base, then force-with-lease push so CI re-runs on fresh ground.
  const pushed = await rebaseAndForcePush(
    runCmd,
    checkoutPath,
    baseBranch,
    pr,
    log,
    input.allowForcePush ?? true,
    input.subagents.resolveConflicts,
    input.signal,
  );
  // Carry the Worker's manifest handle out so the next fix pass for this group can continue it (#107).
  return pushed.kind === 'fixed' ? { kind: 'fixed', handle: worker.handle } : pushed;
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
    '',
    'If you learn a durable repo fact while fixing this — a flaky check, the real format/verify',
    'command, a build quirk — record it with the `memory` tool (write) so the next run has it.',
  ].join('\n');
  return { id: `${group.id}-ci-fix`, text, complexity: 'complex', done: false };
}

async function runFixWorker(input: FixSessionInput, task: Task): Promise<WorkerResult> {
  const { subagents, group, baseBranch, checkoutPath } = input;
  const baseInput: WorkerInput = {
    group,
    task,
    checkoutPath,
    baseBranch,
    styleContents: subagents.styleContents,
    rollingContext: subagents.rollingContext ?? '',
    ...(subagents.formatCommand ? { formatCommand: subagents.formatCommand } : {}),
    ...(subagents.verifyCommand ? { verifyCommand: subagents.verifyCommand } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
    // Same signal the fix Worker's agent gets below, so an abort tears down the editor fanout too.
    ...(input.signal ? { signal: input.signal } : {}),
  };
  if (subagents.runWorkerOverride) {
    return subagents.runWorkerOverride({
      ...baseInput,
      ...(input.priorHandle ? { priorHandle: input.priorHandle } : {}),
    });
  }
  // Summarize-and-continue when the coding-tier context window fills (issue #102).
  const prepareStep = subagents.compactor
    ? buildCompactionStep<WorkerTools>({
        compactor: subagents.compactor,
        modelId: subagents.credentials.modelIdForCapability('coding'),
        ...(input.logger ? { logger: input.logger } : {}),
      })
    : undefined;
  const agent = createWorkerAgent({
    model: subagents.credentials.modelForCapability('coding'),
    tools: subagents.workerTools,
    systemPrompt: buildRolePrompt({
      style: subagents.styleContents,
      roleGuidance: WORKER_SYSTEM_PREFIX,
      cwd: checkoutPath,
      modelId: subagents.credentials.modelIdForCapability('coding'),
      ...(subagents.memoryIndex ? { memoryIndex: subagents.memoryIndex } : {}),
    }),
    ...(prepareStep ? { prepareStep } : {}),
    ...(subagents.timeout !== undefined ? { timeout: subagents.timeout } : {}),
    ...(subagents.providerOptions !== undefined
      ? { providerOptions: subagents.providerOptions }
      : {}),
    ...(subagents.onUsage !== undefined ? { onUsage: subagents.onUsage } : {}),
    ...(subagents.onStepFinish ? { onStepFinish: subagents.onStepFinish } : {}),
    ...(subagents.onEditorStepFinish ? { onEditorStepFinish: subagents.onEditorStepFinish } : {}),
    ...(subagents.onRetry ? { onRetry: subagents.onRetry } : {}),
    ...(subagents.onStream ? { onStream: subagents.onStream } : {}),
    ...(subagents.streamWatchdog ? { streamWatchdog: subagents.streamWatchdog } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  // priorHandle precedence (issue #108): an in-memory handle from an earlier pass this run wins;
  // otherwise, resume from an interrupted transcript's messages (built against this fresh agent).
  const priorHandle =
    input.priorHandle ??
    (subagents.resumeMessages ? { agent, messages: [...subagents.resumeMessages] } : undefined);
  return runWorker(agent, {
    ...baseInput,
    ...(priorHandle ? { priorHandle } : {}),
  });
}

// The one push path for the whole repo: rebase onto origin/<base>, then `git push --force-with-lease`
// (never plain `git push`, which fails against a rebased remote; never plain `--force`). On a rebase
// conflict, when a `resolveConflicts` seam is wired it hands the conflict to an AI subagent (bounded
// retries) and continues the rebase; otherwise — or if the AI can't resolve — it aborts the
// half-applied rebase and blocks. Shared by `runFixSession` (WorkLoop) and the `merge-pr` take-over
// loop so every force-push goes through the same rebase-first guard.
export async function rebaseAndForcePush(
  runCmd: RunCmd,
  checkoutPath: string,
  baseBranch: string,
  pr: number,
  log: LoggerLike | undefined,
  allowForcePush = true,
  resolveConflicts?: ConflictResolver,
  signal?: AbortSignal,
): Promise<PushResult> {
  // This is the only force-push path. When policy forbids it, don't rebase — block cleanly so a
  // human lands the fix, rather than leaving a rebased branch that can't be pushed.
  if (!allowForcePush) {
    return {
      kind: 'blocked',
      reason:
        'force-push is disabled by policy (allowForcePush=false); aitm will not rebase-and-' +
        'force-push the CI fix. The fix is committed on the branch locally — land the PR manually.',
    };
  }
  const cwd = { cwd: checkoutPath };
  // The rebase's own commands carry the run signal so a Ctrl-C kills the in-flight child. Cleanup
  // (`git rebase --abort`, in resolveRebaseConflicts) deliberately does not: an already-aborted
  // signal would kill it on spawn and strand a half-applied rebase in the operator's checkout.
  const cancellable = { cwd: checkoutPath, ...(signal ? { signal } : {}) };
  const cancelled = (stage: string): PushResult => ({
    kind: 'blocked',
    reason: `run cancelled ${stage}; nothing was force-pushed.`,
  });
  if (signal?.aborted) return cancelled(`before the rebase onto origin/${baseBranch}`);
  const fetch = await runCmd('git', ['fetch', 'origin', baseBranch], cancellable);
  if (signal?.aborted) return cancelled(`while fetching origin/${baseBranch}`);
  if (fetch.exitCode !== 0) {
    return { kind: 'blocked', reason: `git fetch origin ${baseBranch} failed: ${gitErr(fetch)}` };
  }
  const rebase = await runCmd('git', ['rebase', `origin/${baseBranch}`], cancellable);
  if (rebase.exitCode !== 0) {
    const resolved = await resolveRebaseConflicts(
      runCmd,
      checkoutPath,
      baseBranch,
      pr,
      log,
      rebase,
      resolveConflicts,
      signal,
    );
    // Blocked → the rebase is already aborted; stop before pushing. Fixed → fall through to push.
    if (resolved.kind === 'blocked') return resolved;
  }
  // A cancel landing after the rebase settled must still not publish: the force-push is the one
  // irreversible step here, and the branch is already rebased locally for whoever resumes.
  if (signal?.aborted) return cancelled(`before the force-push for PR #${pr}`);
  const push = await runCmd('git', ['push', '--force-with-lease'], cancellable);
  if (push.exitCode !== 0) {
    return { kind: 'blocked', reason: `git push --force-with-lease failed: ${gitErr(push)}` };
  }
  log?.info('ci-fix: rebased + force-pushed', { pr, baseBranch });
  return { kind: 'fixed' };
}

// Handle a rebase that stopped on a conflict. With no resolver wired this is byte-for-byte today's
// behavior: abort the half-applied rebase and block. With one, loop up to MAX_CONFLICT_RESOLVE_
// ATTEMPTS: gather the unmerged files, hand them to the resolver (which edits + stages), then drive
// `git rebase --continue` ourselves. A later commit conflicting is a fresh attempt; a resolver that
// gives up, leaves files unmerged past the cap, or a non-conflict rebase failure all abort + block.
async function resolveRebaseConflicts(
  runCmd: RunCmd,
  checkoutPath: string,
  baseBranch: string,
  pr: number,
  log: LoggerLike | undefined,
  firstRebase: RunCmdResult,
  resolveConflicts: ConflictResolver | undefined,
  signal: AbortSignal | undefined,
): Promise<PushResult> {
  const cwd = { cwd: checkoutPath };
  const abortAndBlock = async (reason: string): Promise<PushResult> => {
    await runCmd('git', ['rebase', '--abort'], cwd);
    return { kind: 'blocked', reason };
  };

  // A cancelled run must not start (or continue) an AI resolution pass. Abort the half-applied
  // rebase on the way out: leaving the checkout mid-rebase would strand the operator's working tree.
  const cancelledMidRebase = (): Promise<PushResult> =>
    abortAndBlock(
      `run cancelled while resolving the rebase onto origin/${baseBranch}; the rebase was aborted.`,
    );

  // Checked before the no-resolver branch too, so a rebase the signal itself killed reports the
  // cancel rather than "needs manual resolution".
  if (signal?.aborted) return cancelledMidRebase();
  const manualReason = `git rebase onto origin/${baseBranch} hit conflicts that need manual resolution: ${gitErr(firstRebase)}`;
  if (!resolveConflicts) return abortAndBlock(manualReason);

  for (let attempt = 1; attempt <= MAX_CONFLICT_RESOLVE_ATTEMPTS; attempt++) {
    if (signal?.aborted) return cancelledMidRebase();
    const conflicted = await unmergedPaths(runCmd, cwd);
    if (conflicted.length === 0) {
      // Non-zero rebase with no unmerged paths is not an AI-resolvable content conflict (e.g. a
      // pre-commit hook rejection or an empty commit) — fall back to today's abort+block.
      return abortAndBlock(manualReason);
    }
    log?.info('ci-fix: handing rebase conflict to the AI resolver', {
      pr,
      baseBranch,
      attempt,
      files: conflicted,
    });
    const resolution = await resolveConflicts({
      checkoutPath,
      baseBranch,
      conflictedFiles: conflicted,
      attempt,
    });
    if (resolution.kind === 'unresolved') {
      return abortAndBlock(
        `git rebase onto origin/${baseBranch} hit conflicts the AI could not resolve after ${attempt} attempt(s): ${resolution.reason}`,
      );
    }
    // The resolver edits + stages the files. If any stay unmerged it did not finish the job; spend
    // another attempt rather than continuing onto a half-resolved commit.
    if ((await unmergedPaths(runCmd, cwd)).length > 0) continue;
    // The resolver call above can take minutes; a cancel landing inside it must not drive the
    // rebase forward onto a commit nobody is waiting for.
    if (signal?.aborted) return cancelledMidRebase();
    // Drive the rebase forward. `-c core.editor=true` accepts the reused commit message without
    // opening an editor, so an unattended `git rebase --continue` can never hang.
    const cont = await runCmd('git', ['-c', 'core.editor=true', 'rebase', '--continue'], cwd);
    if (cont.exitCode === 0) {
      log?.info('ci-fix: AI resolved the rebase conflict', { pr, baseBranch, attempts: attempt });
      return { kind: 'fixed' };
    }
    // A non-zero continue with everything staged means a *later* commit now conflicts; loop to
    // resolve the next set, still bounded by the attempt cap.
  }
  return abortAndBlock(
    `git rebase onto origin/${baseBranch} still hit conflicts after ${MAX_CONFLICT_RESOLVE_ATTEMPTS} AI resolution attempt(s); manual resolution needed.`,
  );
}

// Files git left unmerged (conflicted) in the checkout. Empty on any non-zero `git diff` so a
// diff error can't be mistaken for "conflicts remain".
async function unmergedPaths(runCmd: RunCmd, cwd: RunCmdOptions): Promise<string[]> {
  const r = await runCmd('git', ['diff', '--name-only', '--diff-filter=U'], cwd);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function gitErr(r: RunCmdResult): string {
  return r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`;
}

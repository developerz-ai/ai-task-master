// Production ConflictResolver: an AI subagent that resolves the git conflicts a rebase left in the
// worktree, then stages them, so rebaseAndForcePush (ci-fix.ts) can continue the rebase and land the
// PR — the edge over claude-task-master, which just gives up on a conflict.
//
// SRP: this module owns *the agent that resolves conflict markers*. It does NOT drive the rebase
// state machine (that's rebaseAndForcePush's job): the resolver only edits the conflicted files and
// `git add`s them; whether the rebase then completes is decided by the caller re-checking unmerged
// paths + `git rebase --continue`. Reuses the Worker's tool surface, model handle, and role-prompt
// builder — the same generateText primitive the per-file editor fanout uses (worker.ts runEditor) —
// rather than runWorker, whose manifest→checkout→commit flow would corrupt an in-progress rebase.

import { callWithStepTimeout } from '@developerz.ai/ai-claude-compat';
import { generateText, type LanguageModel, stepCountIs, type TimeoutConfiguration } from 'ai';
import type { LoggerLike } from '../logger/logger.ts';
import { type OnUsage, reportUsage, type SubagentInit } from '../subagents/factory.ts';
import { buildRolePrompt } from '../subagents/role-prompt.ts';
import type { WorkerTools } from '../subagents/worker.ts';
import type { ConflictResolver } from './ci-fix.ts';

export type ConflictResolverInit = {
  model: LanguageModel;
  tools: WorkerTools;
  // Coding-style digest (CLAUDE.md / AGENTS.md), prepended to the resolver's system prompt.
  styleContents: string;
  // Per-step LLM request deadline (issue #129). Unset → none. A stalled step aborts → `unresolved`.
  timeout?: TimeoutConfiguration;
  // Provider options forwarded to the generate call (e.g. OpenRouter web_search). Unset → none.
  providerOptions?: SubagentInit<WorkerTools>['providerOptions'];
  // Usage sink, recorded under the worker role. Unset → no accounting.
  onUsage?: OnUsage;
  // Per-step progress/transcript callback. Unset → silent.
  onStepFinish?: SubagentInit<WorkerTools>['onStepFinish'];
  logger?: LoggerLike;
};

export const CONFLICT_RESOLVER_MAX_STEPS = 20;

export const CONFLICT_RESOLVER_SYSTEM_PREFIX = [
  '',
  'You are resolving git MERGE/REBASE CONFLICTS in a worktree that is mid-rebase. A rebase onto the',
  'base branch stopped because commits touched the same lines; your job is to resolve the conflicts',
  'so the rebase can continue.',
  '',
  'For EVERY conflicted file:',
  '- `readFile` it and find each conflict hunk: `<<<<<<<` … `=======` … `>>>>>>>`.',
  '- Resolve each hunk by combining BOTH sides. Never blindly delete one side — the base side and',
  '  your branch side each changed something on purpose; keep both intents coherent. Only drop a',
  '  side when it is genuinely superseded, and only after reading enough to be sure.',
  '- Remove ALL conflict markers. A leftover `<<<<<<<`, `=======`, or `>>>>>>>` is a broken file.',
  '- Write the resolved contents (`editFile`/`multiEdit`, or `writeFile` for a full rewrite).',
  '- `git add` the file once it is clean.',
  '',
  'Do NOT run `git rebase --continue`, `git rebase --abort`, `git commit`, `git checkout`, `git',
  'reset`, or any `git push` — the harness drives the rebase and force-push. You ONLY resolve file',
  'contents and stage them. When every conflicted file is resolved and staged, reply with a',
  'one-line summary.',
].join('\n');

// Build a ConflictResolver bound to a Worker model + tools. Each call runs one bounded agent pass
// over the conflicted files. A thrown/aborted generate (e.g. step timeout) surfaces as `unresolved`
// so the caller blocks with the reason; otherwise it reports `resolved` and the caller verifies by
// re-checking unmerged paths and continuing the rebase.
export function buildConflictResolver(init: ConflictResolverInit): ConflictResolver {
  return async ({ worktreePath, baseBranch, conflictedFiles, attempt }) => {
    init.logger?.info('conflict-resolver: resolving', {
      baseBranch,
      attempt,
      files: conflictedFiles,
    });
    try {
      const result = await callWithStepTimeout(
        () =>
          generateText({
            model: init.model,
            tools: init.tools,
            system: buildRolePrompt({
              style: init.styleContents,
              roleGuidance: CONFLICT_RESOLVER_SYSTEM_PREFIX,
              cwd: worktreePath,
              maxSteps: CONFLICT_RESOLVER_MAX_STEPS,
            }),
            prompt: buildConflictPrompt(worktreePath, baseBranch, conflictedFiles, attempt),
            stopWhen: stepCountIs(CONFLICT_RESOLVER_MAX_STEPS),
            ...(init.providerOptions !== undefined
              ? { providerOptions: init.providerOptions }
              : {}),
            ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
            ...(init.onStepFinish ? { onStepFinish: init.onStepFinish } : {}),
          }),
        init.timeout,
      );
      reportUsage(init.onUsage, result);
      return { kind: 'resolved' };
    } catch (err) {
      return { kind: 'unresolved', reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

function buildConflictPrompt(
  worktreePath: string,
  baseBranch: string,
  conflictedFiles: readonly string[],
  attempt: number,
): string {
  return [
    `Worktree: ${worktreePath}`,
    `Rebasing onto: origin/${baseBranch}`,
    ...(attempt > 1
      ? [`Resolution attempt ${attempt} — the previous pass left files unmerged; finish the job.`]
      : []),
    '',
    'Conflicted files (git left these unmerged):',
    ...conflictedFiles.map((f) => `  - ${f}`),
    '',
    'Resolve every conflict hunk in each file (combine both sides), remove all markers, and',
    '`git add` each file. Do NOT continue or abort the rebase.',
  ].join('\n');
}

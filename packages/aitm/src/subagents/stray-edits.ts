// Restore a clean working tree after a subagent pass leaves uncommitted edits behind. Shared by the
// Worker (non-committing passes: an empty manifest declared clean, a blocked fix, a phantom edit, a
// verify failure, a mid-commit throw) and the Reviewer (between review threads, so a thread's
// `git add -A` fix commit never sweeps a PRIOR thread's stray edits). The shared in-place checkout
// never auto-resets uncommitted changes — a later `checkout -B` carries them onto whatever branch
// comes next — so a stray edit surfaces post-merge as an uncommitted file unless it is dropped here.

import type { BashInput, BashOutput } from '@developerz.ai/ai-claude-compat';
import type { Tool } from 'ai';
import { STATE_DIR } from '../workspace/dirty-tree.ts';

// When the tree is dirty, reset tracked files to HEAD and drop untracked ones. aitm's own state dir
// must survive that: `git clean` without `-x` spares it only when the TARGET repo happens to
// gitignore it, so `-e .ai-task-master` protects it when the repo does not — otherwise this cleanup
// deletes the run's own plan, style cache, generated specialists, and scratch mid-run (same guard as
// InPlaceCheckout.ensureCleanTree). For the same reason the dirty check ignores state-dir entries: in
// a repo that doesn't ignore it, the untracked state dir alone would read as "dirty" and hard-reset
// the tree on every non-committing pass. A clean tree is a no-op (one cheap status check).
// Best-effort: a cleanup fault never masks the caller's real result. Safe because a successful commit
// already captured any real work; whatever remains is, by definition, not meant to ship.
export async function discardStrayEdits(
  bash: Tool<BashInput, BashOutput>,
  checkoutPath: string,
): Promise<void> {
  const exec = bash?.execute;
  if (typeof exec !== 'function') return; // best-effort: no cleanup without a runnable bash tool
  const wt = shQuote(checkoutPath);
  const out = await exec(
    {
      command: `git -C ${wt} status --porcelain`,
      description: 'check for stray edits left by a non-committing subagent pass',
    },
    { toolCallId: `stray-edits-status-${Date.now()}`, messages: [] },
  );
  if (isAsyncIterable(out)) return;
  if (out.exitCode !== 0) return;
  if (!hasStrayEdit(out.stdout)) return;
  for (const command of [
    `git -C ${wt} reset --hard HEAD`,
    `git -C ${wt} clean -fd -e ${STATE_DIR}`,
  ]) {
    try {
      await runBash(exec, command);
    } catch {
      // best-effort: never mask the caller's real result with a cleanup failure
    }
  }
}

// Does this `git status --porcelain` output show anything worth cleaning? State-dir entries do not
// count: in a repo that does not gitignore `.ai-task-master`, its own untracked files would
// otherwise make every tree look dirty. Exported for the unit test of that exact case.
export function hasStrayEdit(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .some((line) => line.trim() !== '' && !line.slice(3).startsWith(STATE_DIR));
}

async function runBash(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  command: string,
): Promise<void> {
  const out = await exec(
    { command, description: 'stray-edit cleanup git step' },
    { toolCallId: `stray-edits-bash-${Date.now()}`, messages: [] },
  );
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  if (out.exitCode !== 0) {
    throw new Error(`bash failed (${out.exitCode}): ${command}\n${out.stderr}`);
  }
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return v !== null && typeof v === 'object' && Symbol.asyncIterator in (v as object);
}

// POSIX shell-quote: wrap in single quotes, escape embedded single quotes.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

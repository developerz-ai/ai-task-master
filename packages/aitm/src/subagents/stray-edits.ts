// Restore a clean working tree after a subagent pass leaves uncommitted edits behind. Shared by the
// Worker (non-committing passes: an empty manifest declared clean, a blocked fix, a phantom edit, a
// verify failure, a mid-commit throw) and the Reviewer (between review threads, so a thread's
// `git add -A` fix commit never sweeps a PRIOR thread's stray edits). The shared in-place checkout
// never auto-resets uncommitted changes — a later `checkout -B` carries them onto whatever branch
// comes next — so a stray edit surfaces post-merge as an uncommitted file unless it is dropped here.

import { STATE_DIR } from '../workspace/dirty-tree.ts';
import { runGit } from '../workspace/git-exec.ts';

// When the tree is dirty, reset tracked files to HEAD and drop untracked ones. aitm's own state dir
// must survive that: `git clean` without `-x` spares it only when the TARGET repo happens to
// gitignore it, so `-e .ai-task-master` protects it when the repo does not — otherwise this cleanup
// deletes the run's own plan, style cache, generated specialists, and scratch mid-run (same guard as
// InPlaceCheckout.ensureCleanTree). For the same reason the dirty check ignores state-dir entries: in
// a repo that doesn't ignore it, the untracked state dir alone would read as "dirty" and hard-reset
// the tree on every non-committing pass. A clean tree is a no-op (one cheap status check).
//
// This is the harness's own cleanup, so it runs git directly — never through the model-facing bash
// tool, whose deny rules (DEFAULT_BASH_RULES) refuse `git reset --hard` and would leave the stray edit
// for the next `git add -A` commit to ship.
//
// Best-effort: a cleanup fault never masks the caller's real result. Safe because a successful commit
// already captured any real work; whatever remains is, by definition, not meant to ship.
export async function discardStrayEdits(checkoutPath: string): Promise<void> {
  let porcelain: string;
  try {
    porcelain = (await runGit(['status', '--porcelain'], { cwd: checkoutPath })).stdout;
  } catch {
    return;
  }
  if (!hasStrayEdit(porcelain)) return;
  for (const args of [
    ['reset', '--hard', 'HEAD'],
    ['clean', '-fd', '-e', STATE_DIR],
  ]) {
    try {
      await runGit(args, { cwd: checkoutPath });
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

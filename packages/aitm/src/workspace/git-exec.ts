// Single guarded chokepoint for git mutations that shell out. aitm runs git directly (it is
// not sandboxed by a Claude-Code git-guard hook), so the safety policy lives here: a `git push`
// may never use a plain `--force` / `-f`, only `--force-with-lease` (which the CI-fix flow uses
// after rebasing). This stops a stray force-push from clobbering a shared branch. All other git
// invocations pass through unchanged.
//
// Self-merge is governed separately by `--no-automerge` (the WorkLoop only merges when autoMerge
// is on), so it is not re-litigated here.

import { execa } from 'execa';

export class GitGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitGuardError';
  }
}

function isForceFlag(arg: string): boolean {
  return arg === '--force' || arg === '-f' || arg.startsWith('--force=');
}

function isLeaseFlag(arg: string): boolean {
  return arg === '--force-with-lease' || arg.startsWith('--force-with-lease=');
}

// Throw if the git invocation violates policy. Pure (no IO) so it is trivially unit-testable.
// Only `git push` is constrained; `git worktree remove --force` and friends are unaffected
// because the rule keys off the `push` subcommand, not the `--force` token alone.
export function assertGitAllowed(args: readonly string[]): void {
  if (args[0] !== 'push') return;
  const hasLease = args.some(isLeaseFlag);
  const hasForce = args.some(isForceFlag);
  if (hasForce && !hasLease) {
    throw new GitGuardError(
      'Refusing `git push --force`: force-push must use --force-with-lease (rebase first).',
    );
  }
}

export type RunGitOptions = { cwd?: string };

// Guarded git runner: validates against policy, then shells out via execa. Use this for every
// git mutation instead of calling execa('git', …) directly.
export async function runGit(args: readonly string[], options?: RunGitOptions) {
  assertGitAllowed(args);
  return execa('git', [...args], options?.cwd ? { cwd: options.cwd } : {});
}

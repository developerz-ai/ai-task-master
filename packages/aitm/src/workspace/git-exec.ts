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

function isForceWithLeaseFlag(arg: string): boolean {
  return arg === '--force-with-lease' || arg.startsWith('--force-with-lease=');
}

// Policy for the git guard. `allowForcePush` (default true) permits `--force-with-lease` on a
// push; set false for repos that forbid ALL force-pushes, so even the lease variant is rejected.
export type GitPolicy = { allowForcePush?: boolean };

// Throw if the git invocation violates policy. Pure (no IO) so it is trivially unit-testable.
// Only `git push` is constrained; `git worktree remove --force` and friends are unaffected
// because the rule keys off the `push` subcommand, not the `--force` token alone.
//
// Any `--force` / `-f` on a push is rejected outright — even alongside `--force-with-lease`,
// because git lets a trailing `--force` override the lease (`push --force-with-lease --force`
// is a plain force-push). `--force-with-lease` on its own is the only sanctioned force path,
// UNLESS `allowForcePush` is false, in which case it too is rejected.
export function assertGitAllowed(args: readonly string[], policy?: GitPolicy): void {
  if (args[0] !== 'push') return;
  if (args.some(isForceFlag)) {
    throw new GitGuardError(
      'Refusing `git push --force` / -f: the only sanctioned force-push is --force-with-lease (rebase first).',
    );
  }
  if (policy?.allowForcePush === false && args.some(isForceWithLeaseFlag)) {
    throw new GitGuardError(
      'Refusing `git push --force-with-lease`: force-push is disabled by policy (allowForcePush=false).',
    );
  }
}

export type RunGitOptions = { cwd?: string } & GitPolicy;

// Guarded git runner: validates against policy, then shells out via execa. Use this for every
// git mutation instead of calling execa('git', …) directly.
export async function runGit(args: readonly string[], options?: RunGitOptions) {
  assertGitAllowed(args, options);
  return execa('git', [...args], options?.cwd ? { cwd: options.cwd } : {});
}

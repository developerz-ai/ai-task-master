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

// A leading `+` on a push refspec (`git push origin +main`, `+src:dst`) is git's plain-force
// form — a history rewrite with no lease, as dangerous as `--force`. Flags start with `-`, so a
// `+`-prefixed token can only be a force refspec.
function isForceRefspec(arg: string): boolean {
  return arg.startsWith('+');
}

function isForceWithLeaseFlag(arg: string): boolean {
  return arg === '--force-with-lease' || arg.startsWith('--force-with-lease=');
}

// Git global options whose value is the next argv element (`--opt <value>`); the long ones also
// accept `--opt=<value>`. Both tokens have to be skipped: stopping on the value would read
// `<dir>` / `<k>=<v>` as the subcommand and wave `git -C dir push --force` straight through.
const VALUED_LONG_OPTIONS = [
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--attr-source',
  '--config-env',
] as const;
const VALUED_GLOBAL_OPTIONS = new Set<string>(['-C', '-c', ...VALUED_LONG_OPTIONS]);
const ATTACHED_VALUE_PREFIXES = [
  ...VALUED_LONG_OPTIONS.map((option) => `${option}=`),
  '--exec-path=',
  '--list-cmds=',
];

// Git global options that consume no value.
const VALUELESS_GLOBAL_OPTIONS = new Set([
  '-p',
  '--paginate',
  '-P',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--no-optional-locks',
  '--no-advice',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--exec-path',
  '--html-path',
  '--man-path',
  '--info-path',
  '-v',
  '--version',
  '-h',
  '--help',
]);

function configSetting(arg: string, next: string | undefined): string | undefined {
  if (arg === '-c' || arg === '--config-env') return next;
  if (arg.startsWith('--config-env=')) return arg.slice('--config-env='.length);
  return undefined;
}

// Index of the subcommand, skipping leading global options. Throws on an option this table does
// not know, because guessing where the subcommand starts is how the guard gets disabled: a
// mis-located subcommand silently reads as "not a push".
function subcommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith('-')) return index;

    // `git -c alias.p='push --force' p` really is a force-push, and no amount of arg inspection
    // can follow an alias to its expansion — so defining one inline is refused outright.
    const setting = configSetting(arg, args[index + 1]);
    if (setting?.toLowerCase().startsWith('alias.')) {
      throw new GitGuardError(
        `Refusing git invocation that defines an alias inline (\`${arg}\`): an alias can expand to a force-push behind an innocent subcommand.`,
      );
    }

    if (VALUED_GLOBAL_OPTIONS.has(arg)) {
      index += 2;
      continue;
    }
    if (
      VALUELESS_GLOBAL_OPTIONS.has(arg) ||
      ATTACHED_VALUE_PREFIXES.some((prefix) => arg.startsWith(prefix))
    ) {
      index += 1;
      continue;
    }
    throw new GitGuardError(
      `Refusing git invocation with unrecognized global option \`${arg}\`: the subcommand cannot be located, so the push guard cannot be applied.`,
    );
  }
  return index;
}

// Policy for the git guard. `allowForcePush` (default true) permits `--force-with-lease` on a
// push; set false for repos that forbid ALL force-pushes, so even the lease variant is rejected.
export type GitPolicy = { allowForcePush?: boolean };

// Throw if the git invocation violates policy. Pure (no IO) so it is trivially unit-testable.
// Only `git push` is constrained; `git checkout --force` and friends are unaffected
// because the rule keys off the `push` subcommand, not the `--force` token alone.
//
// Any `--force` / `-f` on a push is rejected outright — even alongside `--force-with-lease`,
// because git lets a trailing `--force` override the lease (`push --force-with-lease --force`
// is a plain force-push). `--force-with-lease` on its own is the only sanctioned force path,
// UNLESS `allowForcePush` is false, in which case it too is rejected.
//
// Only the tokens AFTER the subcommand are inspected, so a global option's value (`-C +dir`,
// `-c k=--force`) is never mistaken for a force-push.
export function assertGitAllowed(args: readonly string[], policy?: GitPolicy): void {
  const index = subcommandIndex(args);
  if (args[index] !== 'push') return;
  const pushArgs = args.slice(index + 1);
  if (pushArgs.some(isForceFlag) || pushArgs.some(isForceRefspec)) {
    throw new GitGuardError(
      'Refusing `git push --force` / -f / +refspec: the only sanctioned force-push is --force-with-lease (rebase first).',
    );
  }
  if (policy?.allowForcePush === false && pushArgs.some(isForceWithLeaseFlag)) {
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

// Count the commits `head` adds over `origin/<base>`. Returns null when the comparison cannot be
// made (missing ref, detached state, git error) — callers must treat null as "unknown", never as
// zero: an unmeasurable branch may still carry work, so only a definite 0 may skip shipping it.
export async function commitsAheadOfBase(
  cwd: string,
  base: string,
  head: string,
): Promise<number | null> {
  try {
    const result = await runGit(['rev-list', '--count', `origin/${base}..${head}`], { cwd });
    const count = Number.parseInt(result.stdout.trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

// Shell tool, modeled on Claude Code's Bash. Runs a command via `bash -c` with its initial cwd
// set to the worktree. Unlike the FS tools it is intentionally NOT confined to the worktree:
// subagents need git, test and build commands, so `cd`, absolute paths and `git -C` are all
// legitimate. The trust boundary is "an agent is running on your repo" — same as Claude Code
// itself; sandboxing/containerization is out of scope. The worktree is the initial cwd as a
// convenience default, not a security boundary.

import { type Tool, tool } from 'ai';
import { ExecaError, execa } from 'execa';
import { z } from 'zod';

const bashInputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

// Derived from the schema so the type matches `tool()`'s inference exactly — hand-written
// optionals (`timeoutMs?: number`) don't match Zod's `number | undefined` under
// `exactOptionalPropertyTypes`, which makes the AI SDK's invariant Schema<T> reject them.
export type BashInput = z.infer<typeof bashInputSchema>;
export type BashOutput = { stdout: string; stderr: string; exitCode: number };

export type BashToolInit = {
  // Initial cwd for the command.
  cwd: string;
  // Tool-level default timeout. Per-call overrides via `timeoutMs` in the input. Default 60s —
  // enough for `git push`, `git fetch`, `npm install` on small projects.
  defaultTimeoutMs?: number;
  // Test seam — swap out execa to record argv without spawning.
  exec?: typeof execa;
};

const DEFAULT_BASH_TIMEOUT_MS = 60_000;

export function bashTool(init: BashToolInit): Tool<BashInput, BashOutput> {
  const exec = init.exec ?? execa;
  const defaultTimeout = init.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  return tool({
    description:
      'Run a shell command inside the current worktree. Returns stdout, stderr, and exit code. The command runs via `bash -c` with its initial cwd set to the worktree.',
    inputSchema: bashInputSchema,
    execute: async (input): Promise<BashOutput> => {
      const timeout = input.timeoutMs ?? defaultTimeout;
      try {
        // Plain `-c`, not a login shell (`-lc`): a login shell sources /etc/profile and
        // ~/.bash_profile, which in CI can `cd` away from `cwd` before the command runs. Also
        // scrub BASH_ENV — even a non-login `bash -c` sources the file it points to at startup,
        // which could `cd` away and defeat the cwd lock.
        const r = await exec('bash', ['-c', input.command], {
          cwd: init.cwd,
          timeout,
          env: { ...process.env, BASH_ENV: '' },
        });
        return {
          stdout: typeof r.stdout === 'string' ? r.stdout : '',
          stderr: typeof r.stderr === 'string' ? r.stderr : '',
          exitCode: r.exitCode ?? 0,
        };
      } catch (err) {
        if (err instanceof ExecaError) {
          return {
            stdout: typeof err.stdout === 'string' ? err.stdout : '',
            stderr: typeof err.stderr === 'string' ? err.stderr : err.message,
            exitCode: err.exitCode ?? 1,
          };
        }
        // Unknown failure (timeout, ENOENT on bash, etc.): surface as a non-zero exit with the
        // error message in stderr so the LLM can read it and react.
        return {
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
  });
}

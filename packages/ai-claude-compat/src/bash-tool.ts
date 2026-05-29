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

const multiBashInputSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().optional(),
});

// Derived from the schema so the type matches `tool()`'s inference exactly — hand-written
// optionals (`timeoutMs?: number`) don't match Zod's `number | undefined` under
// `exactOptionalPropertyTypes`, which makes the AI SDK's invariant Schema<T> reject them.
export type BashInput = z.infer<typeof bashInputSchema>;
export type BashOutput = { stdout: string; stderr: string; exitCode: number };

export type MultiBashInput = z.infer<typeof multiBashInputSchema>;
// One entry per command that actually ran. On the first failure the sequence stops, so a
// failed run has fewer results than commands. `exitCode` is 0 only if every command in the
// sequence ran and exited 0; otherwise it is the exit code of the command that failed.
// `failedAt` is the index (into the input `commands`) of the command that failed, or null.
export type MultiBashOutput = {
  results: Array<{ command: string } & BashOutput>;
  exitCode: number;
  failedAt: number | null;
};

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
// Hard ceiling on the effective timeout so a single tool call — via a huge per-call timeoutMs or
// an over-large configured default — can't pin the agent loop far longer than intended.
const MAX_BASH_TIMEOUT_MS = 600_000;

// Run a single command via `bash -c`, capturing stdout/stderr/exitCode. Never throws — a
// non-zero exit, a timeout, or a spawn failure all come back as a BashOutput with the detail
// in stderr, so the LLM can read it and react. Shared by both the single and sequence tools.
async function runBash(
  exec: typeof execa,
  cwd: string,
  command: string,
  timeout: number,
): Promise<BashOutput> {
  try {
    // Plain `-c`, not a login shell (`-lc`): a login shell sources /etc/profile and
    // ~/.bash_profile, which in CI can `cd` away from `cwd` before the command runs. Also
    // scrub BASH_ENV — even a non-login `bash -c` sources the file it points to at startup,
    // which could `cd` away and defeat the cwd lock.
    const r = await exec('bash', ['-c', command], {
      cwd,
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
    // Unknown failure (timeout, ENOENT on bash, etc.).
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }
}

export function bashTool(init: BashToolInit): Tool<BashInput, BashOutput> {
  const exec = init.exec ?? execa;
  const defaultTimeout = init.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  return tool({
    description:
      'Run a shell command inside the current worktree. Returns stdout, stderr, and exit code. The command runs via `bash -c` with its initial cwd set to the worktree.',
    inputSchema: bashInputSchema,
    execute: (input): Promise<BashOutput> =>
      runBash(
        exec,
        init.cwd,
        input.command,
        Math.min(input.timeoutMs ?? defaultTimeout, MAX_BASH_TIMEOUT_MS),
      ),
  });
}

// Run a sequence of commands one after another, each in a fresh `bash -c` with cwd reset to the
// worktree (so a `cd` in one command does not leak into the next — chain `cd x && …` within a
// single command for that). Stops at the first non-zero exit: the commands after the failure
// are NOT run. This mirrors a `set -e` script the model can emit as one tool call instead of
// many round-trips. The per-call `timeoutMs` applies to each command, not the whole sequence.
export function multiBashTool(init: BashToolInit): Tool<MultiBashInput, MultiBashOutput> {
  const exec = init.exec ?? execa;
  const defaultTimeout = init.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  return tool({
    description:
      'Run a sequence of shell commands inside the current worktree, one after another. Stops at the first command that exits non-zero — the remaining commands are not run. Each command runs in its own `bash -c` with cwd reset to the worktree, so chain `cd x && …` within a single command if you need a directory change to persist. Returns one result per command that ran, the overall exit code, and the index of the failing command (failedAt) if any.',
    inputSchema: multiBashInputSchema,
    execute: async (input): Promise<MultiBashOutput> => {
      const timeout = Math.min(input.timeoutMs ?? defaultTimeout, MAX_BASH_TIMEOUT_MS);
      const results: Array<{ command: string } & BashOutput> = [];
      for (let i = 0; i < input.commands.length; i++) {
        const command = input.commands[i] ?? '';
        const out = await runBash(exec, init.cwd, command, timeout);
        results.push({ command, ...out });
        if (out.exitCode !== 0) {
          return { results, exitCode: out.exitCode, failedAt: i };
        }
      }
      return { results, exitCode: 0, failedAt: null };
    },
  });
}

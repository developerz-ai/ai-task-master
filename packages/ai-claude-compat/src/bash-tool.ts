// Shell tool, modeled on Claude Code's Bash. Runs a command via `bash -c` with its cwd set to the
// worktree. Unlike the FS tools it is intentionally NOT confined to the worktree: subagents need
// git, test and build commands, so `cd`, absolute paths and `git -C` are all legitimate. The trust
// boundary is "an agent is running on your repo" — same as Claude Code itself; sandboxing is out of
// scope. The worktree is the initial cwd as a convenience default, not a security boundary.
//
// Parity with the Claude Code Bash contract (issue #103): output is truncated (head+tail) so one
// verbose command can't blow the context window; the working directory PERSISTS across calls (a
// `cd` carries to the next call), tracked per tool instance; `description` is a required field; the
// default timeout is 120s (ceiling 600s); and `run_in_background: true` routes to a ProcessManager
// when one is configured.

import { type Tool, tool } from 'ai';
import { ExecaError, execa } from 'execa';
import { z } from 'zod';
import type { ProcessManager } from './background-process.ts';
import { type CommandRule, evaluateCommand } from './command-rules.ts';
import { countLines, type ToolOutputStore } from './tool-output-store.ts';

const bashInputSchema = z.object({
  command: z.string().min(1),
  // Required: a short, human-readable summary of what the command does. No behavioral effect — it
  // matches the harness schema and surfaces in tool-call logs.
  description: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  // Start the command in the background (needs a ProcessManager, see BashToolInit). Omitted/false
  // is a no-op; `true` never fails validation — without a manager it runs in the foreground.
  run_in_background: z.boolean().optional(),
});

const multiBashInputSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().optional(),
});

// Derived from the schema so the type matches `tool()`'s inference exactly — hand-written
// optionals (`timeoutMs?: number`) don't match Zod's `number | undefined` under
// `exactOptionalPropertyTypes`, which makes the AI SDK's invariant Schema<T> reject them.
export type BashInput = z.infer<typeof bashInputSchema>;
// `denied` marks a command blocked by a deny rule before it ever ran (exitCode 126) — additive, so a
// future hooks layer can tell policy denial apart from a real command failure (issue #113).
// `timedOut` marks a command killed for exceeding its timeout (rather than a normal non-zero exit),
// so the model can tell "took too long" from "failed" and retry with a larger timeoutMs (issue #269).
export type BashOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  denied?: boolean;
  timedOut?: boolean;
};

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
  // Initial cwd for the command. bashTool then tracks cwd across calls from here.
  cwd: string;
  // Tool-level default timeout. Per-call overrides via `timeoutMs` in the input. Default 120s —
  // enough for routine installs/builds without spurious timeouts.
  defaultTimeoutMs?: number;
  // Test seam — swap out execa to record argv without spawning.
  exec?: typeof execa;
  // Optional background-process manager. When provided, `run_in_background: true` routes the
  // command to it (spawned without awaiting, in the manager's cwd). Without it, a background
  // request runs in the foreground with a notice. See background-process.ts (issue #103).
  processManager?: ProcessManager;
  // Deny/allow rules evaluated before spawning (issue #113). A denied command never runs and comes
  // back as a typed denial (exitCode 126). Omitted/empty → no governance, behavior unchanged. This
  // is a guardrail on the model's shell, not a sandbox — see command-rules.ts for the evasion limits.
  rules?: CommandRule[];
  // Spill service for oversized output. When provided, a stream over MAX_BASH_OUTPUT_CHARS is written
  // IN FULL to a file and the in-context view keeps the head+tail plus a notice naming the file, so
  // nothing is lost and the model pages the rest with readFile/grep. Omitted → the legacy destructive
  // head/tail truncation (aitm wires the store in a later slice).
  outputStore?: ToolOutputStore;
};

// The result for a command a deny rule blocked before it ran: no spawn, exit 126, the pattern named,
// and the `denied` marker set. Shared by bashTool and multiBashTool.
function deniedResult(pattern: string): BashOutput {
  return {
    stdout: '',
    stderr: `command blocked by rule \`${pattern}\`. Adjust your approach — do not retry the same command.`,
    exitCode: 126,
    denied: true,
  };
}

// Cap for EACH of stdout/stderr returned to the model. A verbose command (npm install, a full test
// run) can otherwise dump megabytes into context. Exported so callers can reason about the bound.
export const MAX_BASH_OUTPUT_CHARS = 30_000;

const DEFAULT_BASH_TIMEOUT_MS = 120_000;
// Hard ceiling on the effective timeout so a single tool call — via a huge per-call timeoutMs or
// an over-large configured default — can't pin the agent loop far longer than intended.
const MAX_BASH_TIMEOUT_MS = 600_000;

// Epilogue appended (newline-separated) to every FOREGROUND bashTool command: save the command's
// exit status, print a NUL-sentinel-delimited $PWD to stdout so the caller can track cwd across
// calls, then exit with the saved status. Runs in the command's own shell (a `cd` persists) and
// after any command that returns a non-zero status normally (`false`, `(exit 3)`, a program's exit
// code) — those still emit the marker. It does NOT run when the command ends the shell itself (a
// bare `exit`/`exec`) or the process is killed (timeout): no marker → the tracked cwd is left
// unchanged. An appended epilogue (not a trap) is used deliberately — an EXIT trap makes bash defer
// a timeout SIGTERM while it waits on a foreground child, which would hang runaway commands.
const CWD_SENTINEL = '\x00__AITM_CWD__';
const CWD_EPILOGUE = `\n__aitm_ec=$?; printf '\\000__AITM_CWD__%s' "$PWD"; exit "$__aitm_ec"`;

const BASH_DESCRIPTION = [
  'Run a shell command inside the current worktree. Returns stdout, stderr, and exit code; a',
  'non-zero exit is returned (not thrown) so you can read the error.',
  'The working directory PERSISTS between calls — a `cd` in one call carries to the next — but',
  'other shell state (variables, functions) does NOT; the shell is re-initialized each call.',
  'Interactive flags (e.g. `git rebase -i`, `git add -i`) are not supported.',
  '`timeoutMs` is in milliseconds (default 120000, ceiling 600000).',
  'Set `run_in_background: true` for a long-lived process (e.g. a dev server): it returns',
  'immediately with a background id you poll via bashOutput.',
  'Avoid using this tool to run `cat`/`head`/`tail`/`sed`/`awk`/`echo` for file access — use the',
  'dedicated read/edit/grep tools instead.',
  'Use the `gh` CLI for GitHub operations (PRs, issues, API).',
  'Some destructive commands (e.g. force pushes, PR merges) may be blocked by repository policy and',
  'returned with exit code 126 — if a command is blocked, revise your approach rather than retrying',
  'or working around it.',
  '`description` is a short human-readable summary of what the command does.',
].join(' ');

// Headroom reserved for the spill notice when sizing the head/tail budget in capStream, so the
// in-context view plus notice stays within MAX_BASH_OUTPUT_CHARS. Generous vs a realistic spill path.
const SPILL_NOTICE_BUDGET = 512;

// Split an over-cap stream into its original HEAD and TAIL slices, sized to fit around a middle notice
// of `noticeLen` chars within MAX_BASH_OUTPUT_CHARS. Head keeps 35% of the budget; the tail keeps the
// rest so an error summary at the end survives. Shared by truncateStream and capStream.
function headTailSlices(s: string, noticeLen: number): { head: string; tail: string } {
  const budget = MAX_BASH_OUTPUT_CHARS - noticeLen;
  const headLen = Math.floor(budget * 0.35);
  return { head: s.slice(0, headLen), tail: s.slice(s.length - (budget - headLen)) };
}

// Legacy destructive truncation: keep the head and tail joined by a notice carrying the original size,
// dropping the middle for good. Used only as the fallback when no spill store is wired.
function truncateStream(s: string): string {
  if (s.length <= MAX_BASH_OUTPUT_CHARS) return s;
  const notice = `\n\n[output truncated: ${s.length} chars total; showing the head and tail]\n\n`;
  const { head, tail } = headTailSlices(s, notice.length);
  return head + notice + tail;
}

// Cap one stream for the model. Within the cap: verbatim. Over the cap WITH a store: the FULL stream
// is spilled to a file and the in-context view keeps the head+tail with the omitted middle replaced by
// a notice naming the file — nothing is destroyed, the model pages the rest with readFile/grep. Over
// the cap WITHOUT a store, or if the spill write fails, it degrades to legacy head/tail truncation.
async function capStream(
  stream: string,
  tool: string,
  store: ToolOutputStore | undefined,
): Promise<string> {
  if (stream.length <= MAX_BASH_OUTPUT_CHARS) return stream;
  if (store === undefined) return truncateStream(stream);
  const spilled = await store.save(tool, stream).catch(() => null);
  if (spilled === null) return truncateStream(stream);
  const { head, tail } = headTailSlices(stream, SPILL_NOTICE_BUDGET);
  const omitted = Math.max(spilled.lines - countLines(head) - countLines(tail), 0);
  const notice = `\n\n[output truncated: ${omitted} lines omitted. Full output: ${spilled.path} — page with readFile(offset/limit) or grep]\n\n`;
  return head + notice + tail;
}

// Split the cwd marker off the end of stdout. Returns the real stdout and the captured cwd, or
// `cwd: undefined` when no marker is present (early exit/exec, timeout, spawn failure). The marker
// is found by its NUL sentinel, so command output containing bare NUL bytes still parses.
function stripCwdMarker(stdout: string): { stdout: string; cwd: string | undefined } {
  const idx = stdout.lastIndexOf(CWD_SENTINEL);
  if (idx === -1) return { stdout, cwd: undefined };
  const cwd = stdout.slice(idx + CWD_SENTINEL.length);
  return { stdout: stdout.slice(0, idx), cwd: cwd.length > 0 ? cwd : undefined };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Low-level runner: `bash -c`, never throws — a non-zero exit, a timeout, or a spawn failure all
// come back as a BashOutput with the detail in stderr. Returns RAW (untruncated, marker-included)
// streams; each tool applies its own marker-strip + truncation. Shared by both tools.
async function execBash(
  exec: typeof execa,
  cwd: string,
  command: string,
  timeout: number,
): Promise<BashOutput> {
  // Plain `-c`, not a login shell (`-lc`): a login shell sources /etc/profile and ~/.bash_profile,
  // which in CI can `cd` away from `cwd` before the command runs. Also scrub BASH_ENV — even a
  // non-login `bash -c` sources the file it points to at startup, which could `cd` away.
  // `detached: true` puts bash in its own process group so the timeout can group-kill the whole
  // tree: a multi-statement command (the cwd epilogue makes every bashTool command multi-statement)
  // keeps bash alive as the parent, and a long-running child would hold the stdout pipe open — so
  // execa's own `timeout` would wait for that pipe to close. We SIGKILL the group ourselves instead.
  const subprocess = exec('bash', ['-c', command], {
    cwd,
    timeout,
    detached: true,
    env: { ...process.env, BASH_ENV: '' },
  });
  // Set the moment our own ceiling fires, so the catch can tell a timeout-kill from a real failure
  // even when the group-SIGKILL (not execa's own timeout) is what actually terminated the tree. The
  // timer is cleared in `finally` if the command finishes first, so it only ever fires on a genuine
  // timeout.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const pid = subprocess.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already exited or unkillable — the awaited result reflects reality either way.
      }
    }
  }, timeout);
  try {
    const r = await subprocess;
    return { stdout: asString(r.stdout), stderr: asString(r.stderr), exitCode: r.exitCode ?? 0 };
  } catch (err) {
    if (err instanceof ExecaError) {
      // A timeout only counts when the subprocess was actually terminated by a signal — our own
      // group-SIGKILL (with the timer having fired) or execa's own `timeout`. Timers fire in libuv's
      // timers phase, ahead of the I/O poll phase, so a command that exits on its own right at the
      // deadline can still trip our timer; but such a self-exit reports an exit code, not a signal, so
      // requiring signal-termination keeps ownership at the exit boundary and never mis-stamps it.
      const killedBySignal = err.isTerminated === true || typeof err.signal === 'string';
      const wasTimeout = (timedOut && killedBySignal) || err.timedOut === true;
      return {
        stdout: asString(err.stdout),
        stderr: typeof err.stderr === 'string' ? err.stderr : err.message,
        exitCode: err.exitCode ?? 1,
        ...(wasTimeout ? { timedOut: true } : {}),
      };
    }
    // Unknown failure (ENOENT on bash, etc.).
    return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
  } finally {
    clearTimeout(timer);
  }
}

export function bashTool(init: BashToolInit): Tool<BashInput, BashOutput> {
  const exec = init.exec ?? execa;
  const defaultTimeout = init.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const manager = init.processManager;
  // Tracked across calls (per tool instance): each subagent invocation constructs a fresh tool.
  let cwd = init.cwd;
  return tool({
    description: BASH_DESCRIPTION,
    inputSchema: bashInputSchema,
    execute: async (input): Promise<BashOutput> => {
      // Governance runs before any spawn — including the background path — so a denied command never
      // starts (issue #113).
      const decision = evaluateCommand(input.command, init.rules ?? []);
      if (decision.denied) return deniedResult(decision.pattern);
      if (input.run_in_background && manager) {
        const status = manager.start(input.command);
        const pid = status.pid !== null ? ` (pid ${status.pid})` : '';
        return {
          stdout: `Started background process ${status.id}${pid}. Read new output with bashOutput({ id: "${status.id}" }) and stop it with killBash({ id: "${status.id}" }).`,
          stderr: '',
          exitCode: 0,
        };
      }
      const timeout = Math.min(input.timeoutMs ?? defaultTimeout, MAX_BASH_TIMEOUT_MS);
      // Marker-strip happens BEFORE truncation, so the epilogue's marker can never be trimmed off.
      const raw = await execBash(exec, cwd, input.command + CWD_EPILOGUE, timeout);
      const { stdout: stripped, cwd: nextCwd } = stripCwdMarker(raw.stdout);
      if (nextCwd !== undefined) cwd = nextCwd;
      // Append the no-manager notice BEFORE truncating, so the final stdout still honors the cap.
      const withNotice =
        input.run_in_background && !manager
          ? `${stripped}\n[run_in_background was requested but no background process manager is configured; the command ran in the foreground]`
          : stripped;
      return {
        stdout: await capStream(withNotice, 'bash', init.outputStore),
        stderr: await capStream(raw.stderr, 'bash', init.outputStore),
        exitCode: raw.exitCode,
        ...(raw.timedOut ? { timedOut: true } : {}),
      };
    },
    // Plain-text: stdout, then a stderr section / exit-code line only when relevant (issue #127).
    toModelOutput: ({ output }) => ({ type: 'text', value: renderBashSection(output) }),
  });
}

// Shared plain-text rendering for a single command result (issue #127): stdout, a `stderr:` section
// only when stderr is non-empty, an `exit code: N` line only when non-zero, and `(no output)` when
// nothing ran to show (empty stdout+stderr on a clean exit).
function renderBashSection(
  o: Pick<BashOutput, 'stdout' | 'stderr' | 'exitCode' | 'timedOut'>,
): string {
  const parts: string[] = [];
  if (o.stdout !== '') parts.push(o.stdout);
  if (o.stderr !== '') parts.push(`stderr:\n${o.stderr}`);
  if (o.exitCode !== 0) parts.push(`exit code: ${o.exitCode}`);
  // A timeout is a kill, not a normal exit — say so, and point at the actionable lever (issue #269).
  if (o.timedOut) {
    parts.push(
      `[timed out — the command was killed for exceeding its timeout, not a normal exit. If it needs longer and is not waiting for interactive input, retry with a larger timeoutMs (ceiling ${MAX_BASH_TIMEOUT_MS} ms).]`,
    );
  }
  return parts.length > 0 ? parts.join('\n') : '(no output)';
}

// Plain-text rendering for a multi-command run (issue #127): one labeled section per command that
// ran, and — when the sequence stopped on a failure — a line naming the failing command's index.
function renderMultiBash(output: MultiBashOutput): string {
  const sections = output.results.map((r) => `$ ${r.command}\n${renderBashSection(r)}`);
  if (output.failedAt !== null) {
    const failed = output.results[output.failedAt];
    sections.push(`[command #${output.failedAt + 1} failed${failed ? `: ${failed.command}` : ''}]`);
  }
  return sections.length > 0 ? sections.join('\n\n') : '(no output)';
}

// Run a sequence of commands one after another, each in a fresh `bash -c` with cwd reset to the
// worktree (so a `cd` in one command does not leak into the next — chain `cd x && …` within a
// single command for that). Stops at the first non-zero exit: the commands after the failure are
// NOT run. This mirrors a `set -e` script the model can emit as one tool call instead of many
// round-trips. The per-call `timeoutMs` applies to each command, not the whole sequence. Each
// command's output is truncated the same way as bashTool.
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
        // A denied command behaves like a failing one: recorded, and the sequence stops here (#113).
        const decision = evaluateCommand(command, init.rules ?? []);
        if (decision.denied) {
          results.push({ command, ...deniedResult(decision.pattern) });
          return { results, exitCode: 126, failedAt: i };
        }
        const out = await execBash(exec, init.cwd, command, timeout);
        results.push({
          command,
          stdout: await capStream(out.stdout, 'multiBash', init.outputStore),
          stderr: await capStream(out.stderr, 'multiBash', init.outputStore),
          exitCode: out.exitCode,
          ...(out.timedOut ? { timedOut: true } : {}),
        });
        if (out.exitCode !== 0) {
          return { results, exitCode: out.exitCode, failedAt: i };
        }
      }
      return { results, exitCode: 0, failedAt: null };
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: renderMultiBash(output) }),
  });
}

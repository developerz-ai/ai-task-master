// Long-lived background processes, modeled on Claude Code's `run_in_background` Bash. The
// blocking bash tools (bash-tool.ts) await a command to exit, so they cannot hold a dev server
// open. ProcessManager spawns `bash -c <command>` without awaiting it, accumulates stdout/stderr
// in capped, incrementally-readable buffers, and lets the agent poll output, kill one process, or
// kill them all on teardown. Same trust boundary as bashTool: not sandboxed, cwd is a convenience
// default. The caller OWNS lifecycle — call killAll() when the run ends or processes leak.
//
// Portability: uses node:child_process spawn (available on Node, Bun, Deno) — no execa, so a
// non-awaited child is straightforward. Linux-targeted like the rest of the shell surface:
// `detached` process groups and negative-pid group signaling are POSIX, no Windows branch.

import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { type Tool, tool } from 'ai';
import { z } from 'zod';

// The slice of a spawned child that ProcessManager consumes. Narrowing the spawn seam to this
// (instead of the full ChildProcess) lets a test inject a controllable fake to reproduce a line
// split across reads — real pipe chunk boundaries are non-deterministic (#154). A real ChildProcess
// satisfies it: its stdio streams are Readables, which are EventEmitters.
export type ManagedChild = {
  stdout: Pick<EventEmitter, 'on'> | null;
  stderr: Pick<EventEmitter, 'on'> | null;
  pid?: number | undefined;
  on: EventEmitter['on'];
  kill(signal?: NodeJS.Signals | number): boolean;
};

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => ManagedChild;

export type BackgroundProcessInit = {
  // Initial cwd for every spawned command.
  cwd: string;
  // Per-stream retained-output cap. Older bytes are dropped from the front past this; the read
  // cursor still advances so a slow poller never re-reads or sees garbled overlaps. Default 256 KiB.
  maxBufferBytes?: number;
  // Grace between the requested kill signal and the SIGKILL escalation. A process still running
  // after this window is force-killed (group-wide). Default 5000 ms.
  killGraceMs?: number;
  // Fired exactly once per process when it reaches a terminal state (normal exit or spawn failure),
  // with the final status. The seam a harness uses to notify on completion; a throwing callback is
  // swallowed so it can never break the manager or sibling processes.
  onExit?: (id: string, status: ProcessStatus) => void;
  // Test seam — swap node:child_process spawn.
  spawn?: SpawnFn;
};

export type ProcessStatus = {
  id: string;
  command: string;
  running: boolean;
  // Exit code once exited; null while still running. Set to the signal-derived 1 on a killed proc.
  exitCode: number | null;
  pid: number | null;
};

export type ProcessOutput = {
  id: string;
  // New bytes since the previous output() call for this id (incremental, like Claude Code's
  // BashOutput). Empty string when nothing new.
  stdout: string;
  stderr: string;
  running: boolean;
  exitCode: number | null;
  // True when the cap dropped bytes the caller had not yet read — there is a gap before `stdout`.
  truncated: boolean;
};

const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;
const DEFAULT_KILL_GRACE_MS = 5000;

// One stream's capped, cursor-tracked accumulation. Two real callers (stdout, stderr) → extracted.
class CappedStream {
  private retained = '';
  private produced = 0; // total bytes ever appended
  private returned = 0; // total bytes ever handed to a reader
  constructor(private readonly cap: number) {}

  append(chunk: string): void {
    this.produced += chunk.length;
    this.retained += chunk;
    if (this.retained.length > this.cap) {
      this.retained = this.retained.slice(this.retained.length - this.cap);
    }
  }

  // Return everything produced-but-not-yet-returned that is still retained, and advance the
  // cursor. `truncated` is true when the cap evicted bytes the reader had not seen.
  read(): { chunk: string; truncated: boolean } {
    const retainedStart = this.produced - this.retained.length;
    const from = Math.max(this.returned, retainedStart);
    const chunk = this.retained.slice(from - retainedStart);
    const truncated = retainedStart > this.returned;
    this.returned = this.produced;
    return { chunk, truncated };
  }
}

type Entry = {
  command: string;
  proc: ManagedChild;
  stdout: CappedStream;
  stderr: CappedStream;
  running: boolean;
  exitCode: number | null;
  // Guards onExit against firing twice when both `error` and `exit` land.
  exitFired: boolean;
  // Pending SIGKILL escalation, cleared when the process exits within grace.
  killTimer: ReturnType<typeof setTimeout> | null;
  // Per-stream trailing partial line (bytes after the last newline) held across consecutive filtered
  // reads so a line split over two reads reassembles. Reset by a raw read or a cap eviction (#154).
  stdoutCarry: string;
  stderrCarry: string;
};

// Return only the lines of `text` matching `re`; the caller has already advanced the read cursor
// over everything, so skipped lines are consumed (not re-delivered) but not shown. `text` is the set
// of COMPLETE lines the caller assembled (filterStream keeps any trailing partial line back), so a
// line split across two reads is matched once reassembled, not as fragments.
function filterLines(text: string, re: RegExp): string {
  if (text === '') return '';
  return text
    .split('\n')
    .filter((line) => re.test(line))
    .join('\n');
}

// Owns the set of background processes started against one cwd. Not a tool itself — bind it to the
// tool factory below, and keep the handle so you can killAll() on teardown.
export class ProcessManager {
  private readonly cwd: string;
  private readonly cap: number;
  private readonly killGraceMs: number;
  private readonly onExit: BackgroundProcessInit['onExit'];
  private readonly spawn: SpawnFn;
  private readonly procs = new Map<string, Entry>();
  private counter = 0;

  constructor(init: BackgroundProcessInit) {
    this.cwd = init.cwd;
    this.cap = init.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.killGraceMs = init.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.onExit = init.onExit;
    this.spawn = init.spawn ?? nodeSpawn;
  }

  // Spawn `bash -c <command>` without awaiting it. Returns immediately with a handle. Same
  // non-login, BASH_ENV-scrubbed shell as bashTool (see bash-tool.ts for the rationale). `detached`
  // puts the command in its own process group so kill() can signal the whole subtree, not just bash.
  start(command: string): ProcessStatus {
    const id = `bg-${++this.counter}`;
    const proc = this.spawn('bash', ['-c', command], {
      cwd: this.cwd,
      env: { ...process.env, BASH_ENV: '' },
      detached: true,
    });
    const entry: Entry = {
      command,
      proc,
      stdout: new CappedStream(this.cap),
      stderr: new CappedStream(this.cap),
      running: true,
      exitCode: null,
      exitFired: false,
      killTimer: null,
      stdoutCarry: '',
      stderrCarry: '',
    };
    proc.stdout?.on('data', (d: Buffer | string) => entry.stdout.append(d.toString()));
    proc.stderr?.on('data', (d: Buffer | string) => entry.stderr.append(d.toString()));
    proc.on('error', (err: Error) => {
      // Spawn failure (e.g. bash missing): record it on stderr and mark exited non-zero so a
      // poller sees the reason instead of a process that never finishes.
      entry.stderr.append(err.message);
      entry.running = false;
      if (entry.exitCode === null) entry.exitCode = 1;
      this.finalize(id, entry);
    });
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      entry.running = false;
      entry.exitCode = code ?? (signal ? 1 : 0);
      this.finalize(id, entry);
    });
    this.procs.set(id, entry);
    return this.statusOf(id, entry);
  }

  output(id: string, filter?: string): ProcessOutput | null {
    const entry = this.procs.get(id);
    if (!entry) return null;
    let re: RegExp | undefined;
    if (filter !== undefined) {
      try {
        re = new RegExp(filter);
      } catch (err) {
        // Invalid regex — report it WITHOUT reading, so the cursor does not advance and the caller
        // can retry with a valid filter and still see the buffered output.
        return {
          id,
          stdout: '',
          stderr: `invalid filter regex: ${(err as Error).message}`,
          running: entry.running,
          exitCode: entry.exitCode,
          truncated: false,
        };
      }
    }
    const out = entry.stdout.read();
    const err = entry.stderr.read();
    let stdout: string;
    let stderr: string;
    if (re) {
      stdout = this.filterStream(entry, 'stdoutCarry', out, re, entry.running);
      stderr = this.filterStream(entry, 'stderrCarry', err, re, entry.running);
    } else {
      // A raw read returns bytes as-is and resets the carry — line reassembly only spans consecutive
      // filtered reads, so a mode switch must not prepend a stale partial to a later filtered read.
      entry.stdoutCarry = '';
      entry.stderrCarry = '';
      stdout = out.chunk;
      stderr = err.chunk;
    }
    return {
      id,
      stdout,
      stderr,
      running: entry.running,
      exitCode: entry.exitCode,
      truncated: out.truncated || err.truncated,
    };
  }

  // Filter one stream's incremental read, reassembling a line split across reads. Bytes after the
  // last newline are held back as a carry and prepended to the next filtered read; a cap eviction
  // (`truncated`) breaks continuity, so the carry is dropped rather than fabricating a spliced line.
  // Once the process has exited, the trailing partial is flushed as a final line — no newline will
  // ever arrive to terminate it.
  private filterStream(
    entry: Entry,
    carryKey: 'stdoutCarry' | 'stderrCarry',
    read: { chunk: string; truncated: boolean },
    re: RegExp,
    running: boolean,
  ): string {
    const combined = (read.truncated ? '' : entry[carryKey]) + read.chunk;
    const nl = combined.lastIndexOf('\n');
    let complete = nl === -1 ? '' : combined.slice(0, nl);
    let rest = nl === -1 ? combined : combined.slice(nl + 1);
    if (!running && rest !== '') {
      complete = complete === '' ? rest : `${complete}\n${rest}`;
      rest = '';
    }
    entry[carryKey] = rest;
    return filterLines(complete, re);
  }

  // Kill one process and everything it spawned. Returns false for an unknown id. A process that
  // already exited returns true (idempotent — the desired end state holds). A process still alive
  // after killGraceMs is escalated to SIGKILL group-wide.
  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const entry = this.procs.get(id);
    if (!entry) return false;
    if (entry.running) {
      this.signalGroup(entry, signal);
      this.scheduleEscalation(entry);
    }
    return true;
  }

  killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const entry of this.procs.values()) {
      if (entry.running) {
        this.signalGroup(entry, signal);
        this.scheduleEscalation(entry);
      }
    }
  }

  list(): ProcessStatus[] {
    return [...this.procs.entries()].map(([id, entry]) => this.statusOf(id, entry));
  }

  // Signal the whole process group (negative pid), falling back to the lone child if the group is
  // already gone — either way the call is idempotent and never throws out.
  private signalGroup(entry: Entry, signal: NodeJS.Signals): void {
    const pid = entry.proc.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        entry.proc.kill(signal);
      } catch {
        // Already reaped — nothing to signal.
      }
    }
  }

  // Arm a one-shot group SIGKILL for a kill that the process ignores. Deliberately NOT cancelled
  // when the group leader (bash) exits: a descendant that ignored SIGTERM can outlive its shell, so
  // the escalation must still reach the group. The final SIGKILL targets the group by pgid — if the
  // group is already gone it is a harmless ESRCH (see signalGroup). The timer is unref'd so it never
  // keeps the event loop alive (guarded for Deno, whose setTimeout returns a numeric id, not a
  // Timeout object).
  private scheduleEscalation(entry: Entry): void {
    if (entry.killTimer) return; // one escalation timer per process
    const timer = setTimeout(() => {
      entry.killTimer = null;
      this.signalGroup(entry, 'SIGKILL');
    }, this.killGraceMs);
    if (typeof timer !== 'number') timer.unref();
    entry.killTimer = timer;
  }

  // Fire onExit once when the tracked process reaches a terminal state. Guarded so `error` + `exit`
  // both landing cannot double-notify. Does NOT touch the escalation timer — see scheduleEscalation.
  private finalize(id: string, entry: Entry): void {
    if (entry.exitFired) return;
    entry.exitFired = true;
    if (this.onExit) {
      try {
        this.onExit(id, this.statusOf(id, entry));
      } catch {
        // A throwing callback must not break the manager or sibling processes.
      }
    }
  }

  private statusOf(id: string, entry: Entry): ProcessStatus {
    return {
      id,
      command: entry.command,
      running: entry.running,
      exitCode: entry.exitCode,
      pid: entry.proc.pid ?? null,
    };
  }
}

// ---- AI-SDK tools bound to one manager -------------------------------------

export type BackgroundBashInput = { command: string };
export type BackgroundBashOutput = ProcessStatus;
export type BashOutputInput = { id: string; filter?: string | undefined };
export type KillBashInput = { id: string };
export type KillBashOutput = { id: string; killed: boolean };
export type ListBackgroundOutput = { processes: ProcessStatus[] };

const backgroundBashInputSchema = z.object({ command: z.string().min(1) });
const idInputSchema = z.object({ id: z.string().min(1) });
const bashOutputInputSchema = z.object({ id: z.string().min(1), filter: z.string().optional() });

export type BackgroundProcessTools = {
  manager: ProcessManager;
  backgroundBash: Tool<BackgroundBashInput, BackgroundBashOutput>;
  bashOutput: Tool<BashOutputInput, ProcessOutput>;
  killBash: Tool<KillBashInput, KillBashOutput>;
  listBackground: Tool<Record<string, never>, ListBackgroundOutput>;
};

// Build a fresh manager + the four tools bound to it. Keep the returned `manager` to killAll() on
// teardown — the tools alone give the agent no way to guarantee cleanup.
export function backgroundProcessTools(init: BackgroundProcessInit): BackgroundProcessTools {
  const manager = new ProcessManager(init);
  const backgroundBash = tool({
    description:
      'Start a long-running shell command in the background (e.g. a dev server) and return immediately with a process id. Does NOT wait for it to exit. Poll its output with bashOutput(id) and stop it with killBash(id). For a command that finishes quickly, use the blocking bash tool instead.',
    inputSchema: backgroundBashInputSchema,
    execute: async (input): Promise<BackgroundBashOutput> => manager.start(input.command),
  });
  const bashOutput = tool({
    description:
      'Read new stdout/stderr produced since the last bashOutput call for a background process id, plus whether it is still running and its exit code once finished. Pass an optional `filter` regex to return only matching lines (the read cursor still advances over everything).',
    inputSchema: bashOutputInputSchema,
    execute: async (input): Promise<ProcessOutput> =>
      manager.output(input.id, input.filter) ?? {
        id: input.id,
        stdout: '',
        stderr: `no background process with id ${input.id}`,
        running: false,
        exitCode: 1,
        truncated: false,
      },
  });
  const killBash = tool({
    description:
      'Stop a background process by id: sends SIGTERM to its whole process group, escalating to SIGKILL after a grace period if it ignores the signal. Idempotent.',
    inputSchema: idInputSchema,
    execute: async (input): Promise<KillBashOutput> => ({
      id: input.id,
      killed: manager.kill(input.id),
    }),
  });
  const listBackground = tool({
    description: 'List all background processes started this session with their running state.',
    inputSchema: z.object({}),
    execute: async (): Promise<ListBackgroundOutput> => ({ processes: manager.list() }),
  });
  return { manager, backgroundBash, bashOutput, killBash, listBackground };
}

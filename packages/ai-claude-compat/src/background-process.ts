// Long-lived background processes, modeled on Claude Code's `run_in_background` Bash. The
// blocking bash tools (bash-tool.ts) await a command to exit, so they cannot hold a dev server
// open. ProcessManager spawns `bash -c <command>` without awaiting it, accumulates stdout/stderr
// in capped, incrementally-readable buffers, and lets the agent poll output, kill one process, or
// kill them all on teardown. Same trust boundary as bashTool: not sandboxed, cwd is a convenience
// default. The caller OWNS lifecycle — call killAll() when the run ends or processes leak.
//
// Portability: uses node:child_process spawn (available on Node, Bun, Deno) — no execa, so a
// non-awaited child is straightforward. Linux-targeted like the rest of the shell surface.

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { type Tool, tool } from 'ai';
import { z } from 'zod';

export type SpawnFn = typeof nodeSpawn;

export type BackgroundProcessInit = {
  // Initial cwd for every spawned command.
  cwd: string;
  // Per-stream retained-output cap. Older bytes are dropped from the front past this; the read
  // cursor still advances so a slow poller never re-reads or sees garbled overlaps. Default 256 KiB.
  maxBufferBytes?: number;
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
  proc: ChildProcess;
  stdout: CappedStream;
  stderr: CappedStream;
  running: boolean;
  exitCode: number | null;
};

// Owns the set of background processes started against one cwd. Not a tool itself — bind it to the
// tool factory below, and keep the handle so you can killAll() on teardown.
export class ProcessManager {
  private readonly cwd: string;
  private readonly cap: number;
  private readonly spawn: SpawnFn;
  private readonly procs = new Map<string, Entry>();
  private counter = 0;

  constructor(init: BackgroundProcessInit) {
    this.cwd = init.cwd;
    this.cap = init.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.spawn = init.spawn ?? nodeSpawn;
  }

  // Spawn `bash -c <command>` without awaiting it. Returns immediately with a handle. Same
  // non-login, BASH_ENV-scrubbed shell as bashTool (see bash-tool.ts for the rationale).
  start(command: string): ProcessStatus {
    const id = `bg-${++this.counter}`;
    const proc = this.spawn('bash', ['-c', command], {
      cwd: this.cwd,
      env: { ...process.env, BASH_ENV: '' },
    });
    const entry: Entry = {
      command,
      proc,
      stdout: new CappedStream(this.cap),
      stderr: new CappedStream(this.cap),
      running: true,
      exitCode: null,
    };
    proc.stdout?.on('data', (d: Buffer | string) => entry.stdout.append(d.toString()));
    proc.stderr?.on('data', (d: Buffer | string) => entry.stderr.append(d.toString()));
    proc.on('error', (err: Error) => {
      // Spawn failure (e.g. bash missing): record it on stderr and mark exited non-zero so a
      // poller sees the reason instead of a process that never finishes.
      entry.stderr.append(err.message);
      entry.running = false;
      if (entry.exitCode === null) entry.exitCode = 1;
    });
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      entry.running = false;
      entry.exitCode = code ?? (signal ? 1 : 0);
    });
    this.procs.set(id, entry);
    return this.statusOf(id, entry);
  }

  output(id: string): ProcessOutput | null {
    const entry = this.procs.get(id);
    if (!entry) return null;
    const out = entry.stdout.read();
    const err = entry.stderr.read();
    return {
      id,
      stdout: out.chunk,
      stderr: err.chunk,
      running: entry.running,
      exitCode: entry.exitCode,
      truncated: out.truncated || err.truncated,
    };
  }

  // Kill one process. Returns false for an unknown id. A process that already exited returns true
  // (idempotent — the desired end state holds).
  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const entry = this.procs.get(id);
    if (!entry) return false;
    if (entry.running) entry.proc.kill(signal);
    return true;
  }

  killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const entry of this.procs.values()) {
      if (entry.running) entry.proc.kill(signal);
    }
  }

  list(): ProcessStatus[] {
    return [...this.procs.entries()].map(([id, entry]) => this.statusOf(id, entry));
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
export type BashOutputInput = { id: string };
export type KillBashInput = { id: string };
export type KillBashOutput = { id: string; killed: boolean };
export type ListBackgroundOutput = { processes: ProcessStatus[] };

const backgroundBashInputSchema = z.object({ command: z.string().min(1) });
const idInputSchema = z.object({ id: z.string().min(1) });

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
      'Read new stdout/stderr produced since the last bashOutput call for a background process id, plus whether it is still running and its exit code once finished.',
    inputSchema: idInputSchema,
    execute: async (input): Promise<ProcessOutput> =>
      manager.output(input.id) ?? {
        id: input.id,
        stdout: '',
        stderr: `no background process with id ${input.id}`,
        running: false,
        exitCode: 1,
        truncated: false,
      },
  });
  const killBash = tool({
    description: 'Stop a background process by id (sends SIGTERM). Idempotent.',
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

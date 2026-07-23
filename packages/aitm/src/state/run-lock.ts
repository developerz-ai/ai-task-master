// Exclusive per-state-dir run lock. A single `run.lock` created with `wx`, so the create itself is
// the mutual exclusion: two `aitm` invocations over one `.ai-task-master/` can never both believe
// they own the run.
//
// Why it exists: StateStore mutates from a write-behind cache of the last state IT wrote, so a peer
// process's writes to state.json are invisible to it. Concurrent runs therefore do not merely
// interleave — they last-writer-wins over each other's plan, group stages and PR numbers.
//
// Why a pid record and not a heartbeat: a killed run leaves its lock behind, and refusing every
// later run until an operator deletes a file by hand is worse than the race it prevents. The holder
// record carries enough to decide without one — same host plus a pid the OS no longer knows means
// nobody holds this, so the lock is taken over. A holder on another host is never probed and never
// stolen.

import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const RUN_LOCK_FILE = 'run.lock';

const RunLockHolderSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  startedAt: z.string(),
  // Identifies this acquisition, not this process: release must not unlink a lock some peer took
  // over after us, and a reused pid is not proof of identity.
  token: z.string(),
});
export type RunLockHolder = z.infer<typeof RunLockHolderSchema>;

export type RunLockHandle = {
  release: () => Promise<void>;
};

// Seams so tests can drive contention and staleness deterministically instead of spawning processes.
export type RunLockDeps = {
  pid?: number;
  host?: string;
  startedAt?: string;
  token?: string;
  isProcessAlive?: (pid: number) => boolean;
};

// Raised at run entry, like DirtyWorkingTree: a precondition the run cannot work around, not a
// failure of the work itself.
export class RunLockHeld extends Error {
  readonly path: string;
  readonly holder: RunLockHolder | null;

  constructor(path: string, holder: RunLockHolder | null) {
    super(refusalMessage(path, holder));
    this.name = 'RunLockHeld';
    this.path = path;
    this.holder = holder;
  }
}

export function runLockPath(stateDir: string): string {
  return join(stateDir, RUN_LOCK_FILE);
}

export async function acquireRunLock(
  stateDir: string,
  deps: RunLockDeps = {},
): Promise<RunLockHandle> {
  const path = runLockPath(stateDir);
  const mine: RunLockHolder = {
    pid: deps.pid ?? process.pid,
    host: deps.host ?? hostname(),
    startedAt: deps.startedAt ?? new Date().toISOString(),
    token: deps.token ?? randomUUID(),
  };
  await mkdir(stateDir, { recursive: true });
  if (await createExclusive(path, mine)) return handle(path, mine);

  const current = await readHolder(path);
  if (!isStale(current, mine.host, deps.isProcessAlive ?? isProcessAlive)) {
    throw new RunLockHeld(path, current);
  }
  // The recorded holder is provably gone, so its lock is debris. Clear it and try once more —
  // a peer that wins the same takeover race owns the dir, and we refuse rather than loop.
  await unlink(path).catch(ignoreMissing);
  if (await createExclusive(path, mine)) return handle(path, mine);
  throw new RunLockHeld(path, await readHolder(path));
}

function handle(path: string, mine: RunLockHolder): RunLockHandle {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Only ever remove OUR acquisition: after a crash and takeover the file on disk can belong to
      // a live peer, and a blind unlink would hand a third process a concurrent run.
      const current = await readHolder(path);
      if (current?.token !== mine.token) return;
      await unlink(path).catch(ignoreMissing);
    },
  };
}

async function createExclusive(path: string, holder: RunLockHolder): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await open(path, 'wx', 0o600);
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    try {
      await fh.writeFile(`${JSON.stringify(holder)}\n`);
    } finally {
      await fh.close();
    }
  } catch (err) {
    // A lock nobody can read is a lock nobody can wait on — take the empty file with us.
    await unlink(path).catch(ignoreMissing);
    throw err;
  }
  return true;
}

// Missing and unreadable-as-a-holder collapse to null on purpose: both mean the file names no
// process this run could defer to. Real I/O faults (EACCES, EIO) still throw.
async function readHolder(path: string): Promise<RunLockHolder | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
  const parsed = RunLockHolderSchema.safeParse(tryParseJson(raw));
  return parsed.success ? parsed.data : null;
}

function isStale(
  holder: RunLockHolder | null,
  host: string,
  alive: (pid: number) => boolean,
): boolean {
  if (holder === null) return true;
  if (holder.host !== host) return false;
  return !alive(holder.pid);
}

// `kill(pid, 0)` sends no signal — it only asks whether the pid exists. ESRCH is the single answer
// proving it does not; EPERM (alive, another user) and anything a runtime declines to implement read
// as alive, because wrongly refusing a lock costs one `rm` while wrongly stealing one corrupts a run.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) !== 'ESRCH';
  }
}

function refusalMessage(path: string, holder: RunLockHolder | null): string {
  const who = holder
    ? `pid ${holder.pid} on ${holder.host}, started ${holder.startedAt}`
    : 'an unidentified process';
  return [
    `Refusing to start: another aitm run holds ${path} (${who}).`,
    'One run at a time may drive a state dir — concurrent runs overwrite the same state.json.',
    `Wait for it to finish, or if that process is gone, remove the lock: rm ${path}`,
  ].join('\n');
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function ignoreMissing(err: unknown): void {
  if (errCode(err) !== 'ENOENT') throw err;
}

function errCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

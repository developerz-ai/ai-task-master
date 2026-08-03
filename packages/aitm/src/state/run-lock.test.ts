import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireRunLock, RunLockHeld, type RunLockHolder, runLockPath } from './run-lock.ts';

async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-lock-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function readLock(stateDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(runLockPath(stateDir), 'utf8')) as Record<string, unknown>;
}

async function writeLock(stateDir: string, holder: RunLockHolder): Promise<void> {
  await writeFile(runLockPath(stateDir), `${JSON.stringify(holder)}\n`);
}

const DEAD = { isProcessAlive: () => false };

test('run-lock: acquire on a missing state dir → creates it and records this process', async () => {
  const tmp = await tempDir();
  try {
    const stateDir = join(tmp.path, '.ai-task-master');
    await acquireRunLock(stateDir);
    const holder = await readLock(stateDir);
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.host, hostname());
    assert.equal(typeof holder.token, 'string');
    assert.ok(!Number.isNaN(Date.parse(String(holder.startedAt))), 'startedAt is a timestamp');
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: second acquire while held → RunLockHeld naming the holder and the path', async () => {
  const tmp = await tempDir();
  try {
    await acquireRunLock(tmp.path);
    const err = await acquireRunLock(tmp.path).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof RunLockHeld, `expected RunLockHeld, got ${String(err)}`);
    assert.equal(err.holder?.pid, process.pid);
    assert.equal(err.path, runLockPath(tmp.path));
    assert.match(err.message, new RegExp(`pid ${process.pid}`));
    assert.match(err.message, /rm .*run\.lock/);
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: release frees the dir for the next acquire', async () => {
  const tmp = await tempDir();
  try {
    const first = await acquireRunLock(tmp.path);
    await first.release();
    await assert.rejects(() => readLock(tmp.path), /ENOENT/);
    await assert.doesNotReject(() => acquireRunLock(tmp.path));
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: release is idempotent', async () => {
  const tmp = await tempDir();
  try {
    const handle = await acquireRunLock(tmp.path);
    await handle.release();
    await assert.doesNotReject(() => handle.release());
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: release leaves a lock a peer took over untouched', async () => {
  const tmp = await tempDir();
  try {
    const mine = await acquireRunLock(tmp.path, { token: 'mine' });
    // A peer that declared us dead now owns the dir; our release must not hand a third run its lock.
    await writeLock(tmp.path, {
      pid: process.pid,
      host: hostname(),
      startedAt: '2026-07-23T00:00:00.000Z',
      token: 'peer',
    });
    await mine.release();
    assert.equal((await readLock(tmp.path)).token, 'peer');
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: holder pid gone on this host → lock taken over', async () => {
  const tmp = await tempDir();
  try {
    await acquireRunLock(tmp.path, { pid: 4242, token: 'crashed' });
    const handle = await acquireRunLock(tmp.path, { ...DEAD, token: 'fresh' });
    assert.equal((await readLock(tmp.path)).token, 'fresh');
    await handle.release();
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: two runs declaring the same holder dead → exactly one takes over', async () => {
  const tmp = await tempDir();
  try {
    await acquireRunLock(tmp.path, { pid: 4242, token: 'crashed' });
    const settled = await Promise.allSettled([
      acquireRunLock(tmp.path, { ...DEAD, token: 'a' }),
      acquireRunLock(tmp.path, { ...DEAD, token: 'b' }),
    ]);

    const won = settled.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1, `expected one winner, got ${won.length}`);
    for (const r of settled) {
      if (r.status === 'rejected') assert.ok(r.reason instanceof RunLockHeld);
    }
    // release() only unlinks its own token, so a lock that disappears is proof the file on disk
    // belongs to the winner rather than to a loser that clobbered it.
    assert.ok(won[0], 'exactly one contender won');
    await won[0].value.release();
    await assert.rejects(() => readLock(tmp.path), /ENOENT/);
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: debris replaced after we judged it dead → refused, and the new lock survives', async () => {
  const tmp = await tempDir();
  try {
    await acquireRunLock(tmp.path, { pid: 4242, token: 'crashed' });
    const peer: RunLockHolder = {
      pid: process.pid,
      host: hostname(),
      startedAt: '2026-07-23T00:00:00.000Z',
      token: 'peer',
    };
    // The liveness probe is the last thing to run before we act on our verdict — a peer that
    // reclaims the dir in that window must not have its lock deleted out from under it.
    const raced = {
      isProcessAlive: (): boolean => {
        writeFileSync(runLockPath(tmp.path), `${JSON.stringify(peer)}\n`);
        return false;
      },
    };

    await assert.rejects(() => acquireRunLock(tmp.path, { ...raced, token: 'late' }), RunLockHeld);
    assert.equal((await readLock(tmp.path)).token, 'peer');
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: takeover leaves no reclaim bookkeeping behind', async () => {
  const tmp = await tempDir();
  try {
    await acquireRunLock(tmp.path, { pid: 4242, token: 'crashed' });
    await acquireRunLock(tmp.path, { ...DEAD, token: 'fresh' });
    assert.deepEqual(await readdir(tmp.path), ['run.lock']);
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: holder on another host → refused even when the pid looks dead', async () => {
  const tmp = await tempDir();
  try {
    await acquireRunLock(tmp.path, { pid: 4242, host: 'build-box' });
    await assert.rejects(() => acquireRunLock(tmp.path, DEAD), RunLockHeld);
    assert.equal((await readLock(tmp.path)).host, 'build-box');
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: unreadable lock file → taken over', async () => {
  const tmp = await tempDir();
  try {
    await writeFile(runLockPath(tmp.path), 'half-written garba');
    await acquireRunLock(tmp.path, { token: 'fresh' });
    assert.equal((await readLock(tmp.path)).token, 'fresh');
  } finally {
    await tmp.cleanup();
  }
});

test('run-lock: a live pid we cannot signal counts as held', async () => {
  const tmp = await tempDir();
  try {
    // pid 1 always exists; probing it yields EPERM as an ordinary user and success as root — both
    // mean alive, and only ESRCH may release someone else's lock.
    await writeLock(tmp.path, {
      pid: 1,
      host: hostname(),
      startedAt: '2026-07-23T00:00:00.000Z',
      token: 'init',
    });
    await assert.rejects(() => acquireRunLock(tmp.path), RunLockHeld);
  } finally {
    await tmp.cleanup();
  }
});

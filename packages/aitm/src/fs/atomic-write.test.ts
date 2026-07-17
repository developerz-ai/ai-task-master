import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { atomicWrite } from './atomic-write.ts';

async function temp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aw-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

type SyncFn = (this: FileHandle) => Promise<void>;

// atomicWrite calls the real fs; to simulate an fsync fault we patch FileHandle.prototype.sync
// (the shared module boundary) for the duration of `body`, then always restore it.
async function withPatchedSync(
  probeDir: string,
  makePatched: (real: SyncFn) => SyncFn,
  body: () => Promise<void>,
): Promise<void> {
  const probePath = join(probeDir, `sync-probe-${randomUUID()}`);
  const probe = await open(probePath, 'w');
  const proto = Object.getPrototypeOf(probe) as { sync: SyncFn };
  const real = proto.sync;
  await probe.close();
  await rm(probePath, { force: true });
  proto.sync = makePatched(real);
  try {
    await body();
  } finally {
    proto.sync = real;
  }
}

test('atomicWrite writes contents to path', async () => {
  const d = await temp();
  try {
    const path = join(d.path, 'file.txt');
    await atomicWrite(path, 'hello\n');
    assert.equal(await readFile(path, 'utf8'), 'hello\n');
  } finally {
    await d.cleanup();
  }
});

test('atomicWrite leaves no .tmp file behind on success', async () => {
  const d = await temp();
  try {
    await atomicWrite(join(d.path, 'file.txt'), 'x');
    const entries = await readdir(d.path);
    assert.deepEqual(entries.sort(), ['file.txt']);
  } finally {
    await d.cleanup();
  }
});

test('atomicWrite overwrites an existing file', async () => {
  const d = await temp();
  try {
    const path = join(d.path, 'f');
    await writeFile(path, 'old');
    await atomicWrite(path, 'new');
    assert.equal(await readFile(path, 'utf8'), 'new');
  } finally {
    await d.cleanup();
  }
});

test('atomicWrite concurrent writes to same path do not collide', async () => {
  const d = await temp();
  try {
    const path = join(d.path, 'race');
    const writes = Array.from({ length: 10 }, (_, i) => atomicWrite(path, `v${i}\n`));
    await Promise.all(writes);
    const entries = await readdir(d.path);
    assert.deepEqual(entries.sort(), ['race']);
    assert.match(await readFile(path, 'utf8'), /^v\d\n$/);
  } finally {
    await d.cleanup();
  }
});

test('atomicWrite creates files with 0o600 perms on POSIX', async () => {
  if (process.platform === 'win32') return;
  const d = await temp();
  try {
    const path = join(d.path, 'secret');
    await atomicWrite(path, 'sk-secret');
    const st = await stat(path);
    assert.equal(st.mode & 0o777, 0o600);
  } finally {
    await d.cleanup();
  }
});

test('atomicWrite: write/sync failure removes the orphan temp and rethrows', async () => {
  if (process.platform === 'win32') return;
  const d = await temp();
  try {
    const path = join(d.path, 'file.txt');
    await withPatchedSync(
      d.path,
      () => () =>
        Promise.reject(Object.assign(new Error('simulated fsync failure'), { code: 'EIO' })),
      async () => {
        await assert.rejects(atomicWrite(path, 'x'), /simulated fsync failure/);
      },
    );
    assert.deepEqual(await readdir(d.path), [], 'no target and no .tmp orphan should remain');
  } finally {
    await d.cleanup();
  }
});

test('atomicWrite: parent-dir fsync runs after rename and tolerates EINVAL', async () => {
  if (process.platform === 'win32') return;
  const d = await temp();
  try {
    const path = join(d.path, 'file.txt');
    let syncCalls = 0;
    await withPatchedSync(
      d.path,
      (real) =>
        function countedSync(this: FileHandle) {
          syncCalls += 1;
          // First sync is the file; the second is the parent dir — reject it as an unsupported op.
          return syncCalls >= 2
            ? Promise.reject(Object.assign(new Error('dir fsync unsupported'), { code: 'EINVAL' }))
            : real.call(this);
        },
      async () => {
        await atomicWrite(path, 'durable\n');
      },
    );
    assert.ok(syncCalls >= 2, 'parent-dir fsync should be attempted after rename');
    assert.equal(await readFile(path, 'utf8'), 'durable\n');
    assert.deepEqual(await readdir(d.path), ['file.txt']);
  } finally {
    await d.cleanup();
  }
});

import assert from 'node:assert/strict';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ReviewThread } from '../github/schema.ts';
import { PrContextStore } from './pr-context-store.ts';

async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-prctx-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test('saveCiFailures writes one full-log file per check plus a summary', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    const ciDir = await store.saveCiFailures(7, [
      { check: 'bun (test + lint)', logs: 'biome format error\nline 2' },
      { check: 'node (test + lint)', logs: 'tsc error TS1234' },
    ]);
    assert.ok(ciDir);
    const files = (await readdir(ciDir as string)).sort();
    assert.deepEqual(files, [
      'failed_bun_test_lint.txt',
      'failed_node_test_lint.txt',
      'summary.txt',
    ]);
    const bun = await readFile(join(ciDir as string, 'failed_bun_test_lint.txt'), 'utf8');
    assert.match(bun, /CI check failed: bun \(test \+ lint\)/);
    assert.match(bun, /biome format error/); // full logs, not truncated
    const summary = await readFile(join(ciDir as string, 'summary.txt'), 'utf8');
    assert.match(summary, /2 failed check/);
  } finally {
    await dir.cleanup();
  }
});

test('saveCiFailures returns null and writes nothing when there are no failures', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    assert.equal(await store.saveCiFailures(7, []), null);
  } finally {
    await dir.cleanup();
  }
});

test('saveCiFailures disambiguates checks that sanitize to the same name', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    const ciDir = await store.saveCiFailures(1, [
      { check: 'test (1)', logs: 'a' },
      { check: 'test [1]', logs: 'b' },
    ]);
    const files = (await readdir(ciDir as string)).filter((f) => f.startsWith('failed_'));
    assert.equal(new Set(files).size, 2); // no clobber
  } finally {
    await dir.cleanup();
  }
});

test('saveComments writes one file per thread plus a summary', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    const threads: ReviewThread[] = [
      {
        id: 't1',
        isResolved: false,
        path: 'src/a.ts',
        comments: [{ id: 'c1', body: 'fix this', author: 'coderabbit' }],
      },
    ];
    const commentsDir = await store.saveComments(5, threads);
    assert.ok(commentsDir);
    const files = (await readdir(commentsDir as string)).sort();
    assert.deepEqual(files, ['001_src_a.ts.txt', 'summary.txt']);
    const c = await readFile(join(commentsDir as string, '001_src_a.ts.txt'), 'utf8');
    assert.match(c, /@coderabbit:/);
    assert.match(c, /fix this/);
  } finally {
    await dir.cleanup();
  }
});

test('readAddressedThreads returns an empty set when nothing was recorded', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    const addressed = await store.readAddressedThreads(3);
    assert.equal(addressed.size, 0);
  } finally {
    await dir.cleanup();
  }
});

test('recordAddressedThreads persists ids that readAddressedThreads can read back', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    await store.recordAddressedThreads(3, ['t1', 't2']);
    const addressed = await store.readAddressedThreads(3);
    assert.deepEqual([...addressed].sort(), ['t1', 't2']);
    const raw = await readFile(join(store.prDir(3), 'addressed_threads.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), ['t1', 't2']);
  } finally {
    await dir.cleanup();
  }
});

test('recordAddressedThreads merges across calls and de-dups', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    await store.recordAddressedThreads(3, ['t1', 't2']);
    await store.recordAddressedThreads(3, ['t2', 't3']);
    const addressed = await store.readAddressedThreads(3);
    assert.deepEqual([...addressed].sort(), ['t1', 't2', 't3']);
  } finally {
    await dir.cleanup();
  }
});

test('recordAddressedThreads: concurrent appends preserve the union with no lost ids', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    const batches = [
      ['t1', 't2'],
      ['t3', 't4'],
      ['t5', 't6'],
      ['t2', 't7'],
    ];
    await Promise.all(batches.map((ids) => store.recordAddressedThreads(4, ids)));
    const addressed = await store.readAddressedThreads(4);
    assert.deepEqual([...addressed].sort(), ['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
    // On-disk file is the merged union, valid JSON — no half-written clobber from the race.
    const raw = await readFile(join(store.prDir(4), 'addressed_threads.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), ['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
  } finally {
    await dir.cleanup();
  }
});

test('recordAddressedThreads writes nothing for an empty id list', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    await store.recordAddressedThreads(3, []);
    await assert.rejects(() => readdir(store.prDir(3)));
  } finally {
    await dir.cleanup();
  }
});

test('saveCiFailures: a crash mid-write leaves no partial or orphan-tmp file (atomic write)', async () => {
  if (process.platform === 'win32') return;
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    // Patch FileHandle.prototype.writeFile (the shared module boundary atomicWrite goes through)
    // to fail on its first call, simulating a crash mid-write. Mirrors atomic-write.test.ts.
    const probe = await open(join(dir.path, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as {
      writeFile: (this: FileHandle, data: string) => Promise<void>;
    };
    const real = proto.writeFile;
    await probe.close();
    await rm(join(dir.path, 'probe'), { force: true });
    proto.writeFile = function patched(this: FileHandle) {
      return Promise.reject(new Error('simulated crash mid-write'));
    };
    try {
      await assert.rejects(
        store.saveCiFailures(7, [{ check: 'bun', logs: 'log body' }]),
        /simulated crash mid-write/,
      );
    } finally {
      proto.writeFile = real;
    }
    // The target dir exists (mkdir ran) but holds neither the final file nor an orphaned .tmp —
    // atomicWrite's own failure path already cleaned up the temp file before rethrowing.
    const ciDir = join(store.prDir(7), 'ci');
    assert.deepEqual(await readdir(ciDir), [], 'no partial or tmp file left behind');
  } finally {
    await dir.cleanup();
  }
});

test('clear removes a PR context dir', async () => {
  const dir = await tempDir();
  try {
    const store = new PrContextStore(dir.path);
    await store.saveCiFailures(9, [{ check: 'x', logs: 'y' }]);
    await store.clear(9);
    await assert.rejects(() => readdir(store.prDir(9)));
  } finally {
    await dir.cleanup();
  }
});

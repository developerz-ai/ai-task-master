import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

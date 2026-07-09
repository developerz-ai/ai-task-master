import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileStateTracker, hashContent, hashFile } from './file-state.ts';

test('FileStateTracker: unseen paths report not-seen and never stale', () => {
  const t = new FileStateTracker();
  assert.equal(t.hasSeen('/x/a.ts'), false);
  assert.equal(t.isStale('/x/a.ts', hashContent('anything')), false);
  assert.deepEqual(t.staleFiles(), []);
});

test('FileStateTracker: record marks seen; matching hash is fresh, differing hash is stale', () => {
  const t = new FileStateTracker();
  t.record('/x/a.ts', hashContent('v1'), 'read');
  assert.equal(t.hasSeen('/x/a.ts'), true);
  assert.equal(t.isStale('/x/a.ts', hashContent('v1')), false);
  assert.equal(t.isStale('/x/a.ts', hashContent('v2')), true);
  assert.deepEqual(t.staleFiles(), ['/x/a.ts']);
});

test('FileStateTracker: re-recording a stale file clears the stale mark', () => {
  const t = new FileStateTracker();
  t.record('/x/a.ts', hashContent('v1'), 'read');
  assert.equal(t.isStale('/x/a.ts', hashContent('v2')), true);
  assert.deepEqual(t.staleFiles(), ['/x/a.ts']);
  t.record('/x/a.ts', hashContent('v2'), 'edit');
  assert.deepEqual(t.staleFiles(), []);
  assert.equal(t.isStale('/x/a.ts', hashContent('v2')), false);
});

test('hashContent and hashFile agree on the same UTF-8 file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compat-fstate-'));
  try {
    const content = 'line one\nline two\nünïcödé ✅\n';
    const file = join(dir, 'f.txt');
    await writeFile(file, content, 'utf8');
    assert.equal(await hashFile(file), hashContent(content));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

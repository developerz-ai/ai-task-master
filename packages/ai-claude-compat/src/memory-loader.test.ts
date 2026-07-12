import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadMemoryIndex,
  MEMORY_INDEX_FILE,
  memoryFileStem,
  readMemory,
  removeMemory,
  upsertMemory,
} from './memory-loader.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aitm-memory-'));
}

test('loadMemoryIndex: missing dir/file returns an empty array without throwing', async () => {
  assert.deepEqual(await loadMemoryIndex('/tmp/aitm-does-not-exist-xyz'), []);
});

test('memoryFileStem: reduces a name to a safe kebab stem (no path separators survive)', () => {
  assert.equal(memoryFileStem('Flaky CI Job'), 'flaky-ci-job');
  assert.equal(memoryFileStem('../escape/x'), 'escape-x');
  assert.equal(memoryFileStem('a__b--c'), 'a-b-c');
});

test('upsertMemory + loadMemoryIndex + readMemory round-trip a memory', async () => {
  const dir = await tmp();
  try {
    await upsertMemory(dir, {
      name: 'flaky-e2e',
      description: 'the e2e job flakes on cold cache — retry once',
      type: 'project',
      body: 'The `e2e` CI job fails ~1/5 on a cold Docker layer cache. Re-run before assuming a real break.',
    });
    const index = await loadMemoryIndex(dir);
    assert.equal(index.length, 1);
    assert.deepEqual(index[0], {
      file: 'flaky-e2e.md',
      description: 'the e2e job flakes on cold cache — retry once',
    });
    const mem = await readMemory(dir, 'flaky-e2e');
    assert.equal(mem?.name, 'flaky-e2e');
    assert.equal(mem?.type, 'project');
    assert.match(mem?.body ?? '', /cold Docker layer cache/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upsertMemory with an existing name updates in place — one file, one index line', async () => {
  const dir = await tmp();
  try {
    await upsertMemory(dir, {
      name: 'verify-cmd',
      description: 'old',
      type: 'reference',
      body: 'v1',
    });
    await upsertMemory(dir, {
      name: 'verify-cmd',
      description: 'new',
      type: 'reference',
      body: 'v2',
    });
    const index = await loadMemoryIndex(dir);
    assert.equal(index.length, 1, 'no duplicate index line');
    assert.equal(index[0]?.description, 'new', 'index line updated');
    assert.equal((await readMemory(dir, 'verify-cmd'))?.body, 'v2', 'file overwritten');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upsertMemory keeps multiple distinct memories and their index lines', async () => {
  const dir = await tmp();
  try {
    await upsertMemory(dir, { name: 'a', description: 'A', type: 'project', body: 'a' });
    await upsertMemory(dir, { name: 'b', description: 'B', type: 'reference', body: 'b' });
    const index = await loadMemoryIndex(dir);
    assert.deepEqual(index.map((e) => e.file).sort(), ['a.md', 'b.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removeMemory deletes the file and its index line together; removing an absent one is a no-op', async () => {
  const dir = await tmp();
  try {
    await upsertMemory(dir, { name: 'gone', description: 'x', type: 'project', body: 'x' });
    await upsertMemory(dir, { name: 'stay', description: 'y', type: 'project', body: 'y' });
    await removeMemory(dir, 'gone');
    const index = await loadMemoryIndex(dir);
    assert.deepEqual(
      index.map((e) => e.file),
      ['stay.md'],
    );
    assert.equal(await readMemory(dir, 'gone'), null, 'file deleted');
    await removeMemory(dir, 'never-existed'); // must not throw
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadMemoryIndex skips the header and any non-index lines', async () => {
  const dir = await tmp();
  try {
    await writeFile(
      join(dir, MEMORY_INDEX_FILE),
      '# Memory Index\n\nsome preamble prose\n- [a](a.md) — desc a\n',
      'utf8',
    );
    const index = await loadMemoryIndex(dir);
    assert.deepEqual(index, [{ file: 'a.md', description: 'desc a' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upsertMemory writes parseable frontmatter with a nested metadata.type', async () => {
  const dir = await tmp();
  try {
    await upsertMemory(dir, { name: 'm', description: 'd', type: 'feedback', body: 'fact' });
    const raw = await readFile(join(dir, 'm.md'), 'utf8');
    assert.match(raw, /metadata:\n {2}type: feedback/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

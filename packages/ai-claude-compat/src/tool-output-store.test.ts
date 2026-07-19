import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { ToolOutputStore } from './tool-output-store.ts';

async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'compat-tool-output-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

test('tool-output-store: save writes full content and returns an absolute path → readable file', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const content = 'line 1\nline 2\nline 3\n';
    const spill = await store.save('bash', content);
    assert.ok(isAbsolute(spill.path));
    assert.equal(await readFile(spill.path, 'utf8'), content);
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: save filename shape → <ts>-<tool>-<n>.txt inside the dir', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const spill = await store.save('bash', 'x');
    assert.equal(dirname(spill.path), dir.path);
    assert.match(basename(spill.path), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-bash-1\.txt$/);
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: save increments the counter → distinct paths per call', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const a = await store.save('grep', 'a');
    const b = await store.save('grep', 'b');
    assert.notEqual(a.path, b.path);
    assert.match(basename(a.path), /-grep-1\.txt$/);
    assert.match(basename(b.path), /-grep-2\.txt$/);
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: concurrent saves → distinct files, both written', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const [a, b] = await Promise.all([store.save('bash', 'A'), store.save('bash', 'B')]);
    assert.notEqual(a.path, b.path);
    assert.equal(await readFile(a.path, 'utf8'), 'A');
    assert.equal(await readFile(b.path, 'utf8'), 'B');
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: save creates a missing (nested) directory on demand', async () => {
  const dir = await tempDir();
  try {
    const nested = join(dir.path, 'tool-output', 'deep');
    const store = new ToolOutputStore(nested);
    const spill = await store.save('glob', 'x');
    assert.equal(dirname(spill.path), nested);
    assert.equal(await readFile(spill.path, 'utf8'), 'x');
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: save sanitizes an unsafe tool name → no path separators leak', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const spill = await store.save('multi/Bash!!', 'x');
    const name = basename(spill.path);
    assert.equal(dirname(spill.path), dir.path);
    assert.match(name, /-multi-Bash-1\.txt$/);
    assert.ok(!name.includes('/'));
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: save reports byte length as UTF-8 bytes, not char count', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const spill = await store.save('bash', 'é\n'); // é is 2 bytes, \n is 1
    assert.equal(spill.bytes, 3);
    assert.equal(spill.lines, 1);
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: save counts newline-delimited lines across edge cases', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const cases: Array<[string, number]> = [
      ['', 0],
      ['a', 1],
      ['a\n', 1],
      ['a\nb', 2],
      ['a\nb\n', 2],
      ['\n', 1],
      ['a\n\n', 2],
    ];
    for (const [content, expected] of cases) {
      const spill = await store.save('bash', content);
      assert.equal(spill.lines, expected, `lines for ${JSON.stringify(content)}`);
    }
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: cleanup removes files older than maxAgeDays, keeps recent → count', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const old = await store.save('bash', 'old');
    const fresh = await store.save('bash', 'fresh');
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS);
    await utimes(old.path, eightDaysAgo, eightDaysAgo);

    const removed = await store.cleanup(7);

    assert.equal(removed, 1);
    await assert.rejects(() => stat(old.path));
    assert.equal(await readFile(fresh.path, 'utf8'), 'fresh');
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: cleanup defaults to a 7-day retention window', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    const old = await store.save('bash', 'old');
    const sixDays = new Date(Date.now() - 6 * DAY_MS);
    const eightDays = new Date(Date.now() - 8 * DAY_MS);
    await utimes(old.path, eightDays, eightDays);
    assert.equal(await store.cleanup(), 1);

    const recent = await store.save('bash', 'recent');
    await utimes(recent.path, sixDays, sixDays);
    assert.equal(await store.cleanup(), 0);
    assert.equal(await readFile(recent.path, 'utf8'), 'recent');
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: cleanup on a never-used store (no directory) → 0, no throw', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(join(dir.path, 'never-created'));
    assert.equal(await store.cleanup(), 0);
  } finally {
    await dir.cleanup();
  }
});

test('tool-output-store: cleanup leaves non-.txt files untouched', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(dir.path);
    await store.save('bash', 'x'); // ensures the dir exists
    const stray = join(dir.path, 'keep.log');
    await writeFile(stray, 'not a spill file');
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS);
    await utimes(stray, eightDaysAgo, eightDaysAgo);

    await store.cleanup(7);

    assert.equal(await readFile(stray, 'utf8'), 'not a spill file');
  } finally {
    await dir.cleanup();
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { atomicWrite } from './atomic-write.ts';

async function temp(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aw-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
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

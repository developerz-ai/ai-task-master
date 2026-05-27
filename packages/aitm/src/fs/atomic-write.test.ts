import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

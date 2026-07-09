import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { atomicWriteFile } from './atomic-write.ts';

async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'compat-atomic-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test('atomicWriteFile: writes content and leaves no temp file behind', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir.path, 'f.txt');
    await atomicWriteFile(file, 'hello\nworld\n');
    assert.equal(await readFile(file, 'utf8'), 'hello\nworld\n');
    // No `<name>.<uuid>.tmp` residue.
    const entries = await readdir(dir.path);
    assert.deepEqual(entries, ['f.txt']);
  } finally {
    await dir.cleanup();
  }
});

test('atomicWriteFile: preserves an existing file’s mode (exec bit survives a rewrite)', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir.path, 'script.sh');
    await writeFile(file, '#!/bin/sh\necho old\n');
    await chmod(file, 0o755);
    await atomicWriteFile(file, '#!/bin/sh\necho new\n');
    assert.equal(await readFile(file, 'utf8'), '#!/bin/sh\necho new\n');
    assert.equal((await stat(file)).mode & 0o777, 0o755);
  } finally {
    await dir.cleanup();
  }
});

test('atomicWriteFile: a new file gets the umask default (not 0o600)', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir.path, 'new.txt');
    await atomicWriteFile(file, 'x');
    // Not the secret-config 0o600 the aitm copy forces — a normal group/other-readable default.
    assert.notEqual((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await dir.cleanup();
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveInside } from './safe-path.ts';

async function tempDir(
  prefix = 'compat-path-',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test('resolveInside: returns the absolute path for a relative target inside root', async () => {
  const dir = await tempDir();
  try {
    const out = await resolveInside(dir.path, 'a/b.txt');
    assert.equal(out, join(dir.path, 'a/b.txt'));
  } finally {
    await dir.cleanup();
  }
});

test('resolveInside: accepts an absolute path that stays inside root', async () => {
  const dir = await tempDir();
  try {
    const out = await resolveInside(dir.path, join(dir.path, 'x.txt'));
    assert.equal(out, join(dir.path, 'x.txt'));
  } finally {
    await dir.cleanup();
  }
});

test('resolveInside: rejects ../ escape by string', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => resolveInside(dir.path, '../etc/passwd'), /path escapes worktree/);
  } finally {
    await dir.cleanup();
  }
});

test('resolveInside: rejects an absolute path outside root', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => resolveInside(dir.path, '/etc/hostname'), /path escapes worktree/);
  } finally {
    await dir.cleanup();
  }
});

test('resolveInside: rejects a symlink pointing outside root', async () => {
  const dir = await tempDir();
  const outside = await tempDir('compat-path-out-');
  try {
    await writeFile(join(outside.path, 'secret.txt'), 'secret\n');
    await symlink(join(outside.path, 'secret.txt'), join(dir.path, 'link.txt'));
    await assert.rejects(() => resolveInside(dir.path, 'link.txt'), /escapes worktree via symlink/);
  } finally {
    await dir.cleanup();
    await outside.cleanup();
  }
});

test('resolveInside: rejects a write through a parent symlink pointing outside', async () => {
  const dir = await tempDir();
  const outside = await tempDir('compat-path-out-');
  try {
    await symlink(outside.path, join(dir.path, 'escape'));
    await assert.rejects(
      () => resolveInside(dir.path, 'escape/foo.txt'),
      /escapes worktree via symlink/,
    );
  } finally {
    await dir.cleanup();
    await outside.cleanup();
  }
});

import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempRepo } from './temp-repo.ts';

test('creates a temp dir with a .git directory', async () => {
  const repo = await makeTempRepo();
  try {
    await access(join(repo.path, '.git'));
  } finally {
    await repo.cleanup();
  }
});

test('cleanup removes the directory', async () => {
  const repo = await makeTempRepo();
  const { path } = repo;
  await repo.cleanup();
  await assert.rejects(() => access(path), 'directory should be gone after cleanup');
});

test('withClaudeMd seeds a CLAUDE.md file', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await access(join(repo.path, 'CLAUDE.md'));
  } finally {
    await repo.cleanup();
  }
});

test('without withClaudeMd no CLAUDE.md is created', async () => {
  const repo = await makeTempRepo();
  try {
    await assert.rejects(() => access(join(repo.path, 'CLAUDE.md')), 'CLAUDE.md should not exist');
  } finally {
    await repo.cleanup();
  }
});

test('setup failure (git init throws) removes the temp dir instead of leaking it', async () => {
  const stubBinDir = await mkdtemp(join(tmpdir(), 'aitm-git-stub-'));
  const gitStubPath = join(stubBinDir, 'git');
  await writeFile(gitStubPath, '#!/bin/sh\nexit 1\n');
  await chmod(gitStubPath, 0o755);

  // Point TMPDIR at a private root for the duration: makeTempRepo resolves os.tmpdir() per call,
  // so the leak check then sees only what THIS test created. Scanning the shared tmpdir instead
  // made the assertion fail whenever another test file (node --test runs files in parallel) held
  // an aitm-test- dir of its own at that moment — a failure about someone else's live directory.
  const tmpRoot = await mkdtemp(join(tmpdir(), 'aitm-leakcheck-'));
  const originalPath = process.env.PATH;
  const originalTmpdir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = tmpRoot;
    process.env.PATH = stubBinDir;
    await assert.rejects(() => makeTempRepo(), 'makeTempRepo should reject when git init fails');
  } finally {
    process.env.PATH = originalPath;
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(stubBinDir, { recursive: true, force: true });
  }

  const leaked = await readdir(tmpRoot);
  await rm(tmpRoot, { recursive: true, force: true });
  assert.deepEqual(leaked, [], 'no directory should remain after a failed setup');
});

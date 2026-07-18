import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempRepo } from './temp-repo.ts';

const listTempRepoDirs = async (): Promise<string[]> =>
  (await readdir(tmpdir())).filter((entry) => entry.startsWith('aitm-test-'));

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

  const originalPath = process.env.PATH;
  const before = await listTempRepoDirs();
  try {
    process.env.PATH = stubBinDir;
    await assert.rejects(() => makeTempRepo(), 'makeTempRepo should reject when git init fails');
  } finally {
    process.env.PATH = originalPath;
    await rm(stubBinDir, { recursive: true, force: true });
  }
  const after = await listTempRepoDirs();
  assert.deepEqual(after, before, 'no aitm-test- directory should remain after a failed setup');
});

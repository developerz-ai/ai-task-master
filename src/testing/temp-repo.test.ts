import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
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

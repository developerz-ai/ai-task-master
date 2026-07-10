import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectGitRepo, envBlock } from './env-block.ts';

test('envBlock wraps the fields in an <env> block with the working directory', () => {
  const out = envBlock({ cwd: '/tmp/work', date: '2026-05-27' });
  assert.match(out, /^<env>\n/);
  assert.match(out, /\n<\/env>$/);
  assert.match(out, /Working directory: \/tmp\/work/);
  assert.match(out, /Platform: /);
  assert.match(out, /Today's date: 2026-05-27/);
});

test('envBlock includes the git-repo line only when isGitRepo is set', () => {
  assert.match(envBlock({ cwd: '/r', isGitRepo: true }), /Is directory a git repo: Yes/);
  assert.match(envBlock({ cwd: '/r', isGitRepo: false }), /Is directory a git repo: No/);
  assert.doesNotMatch(envBlock({ cwd: '/r' }), /Is directory a git repo/);
});

test('envBlock renders Model + Knowledge cutoff lines only when set (issue #116)', () => {
  const withBoth = envBlock({
    cwd: '/r',
    modelId: 'anthropic/claude-sonnet-4.5',
    knowledgeCutoff: 'January 2026',
  });
  assert.match(withBoth, /Model: anthropic\/claude-sonnet-4\.5/);
  assert.match(withBoth, /Knowledge cutoff: January 2026/);
  // Both omitted when undefined — same contract as isGitRepo.
  const without = envBlock({ cwd: '/r' });
  assert.doesNotMatch(without, /Model:/);
  assert.doesNotMatch(without, /Knowledge cutoff:/);
});

test('detectGitRepo: true at a repo root, in a nested subdir, and with a .git file (linked worktree); false outside (issue #116)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aitm-git-'));
  const outside = await mkdtemp(join(tmpdir(), 'aitm-nogit-'));
  try {
    // A normal checkout: .git is a directory.
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'src', 'deep'), { recursive: true });
    assert.equal(detectGitRepo(root), true, 'repo root');
    assert.equal(detectGitRepo(join(root, 'src', 'deep')), true, 'nested subdir walks up to .git');

    // A linked worktree: .git is a plain file pointing at the real gitdir.
    const wt = await mkdtemp(join(tmpdir(), 'aitm-wt-'));
    try {
      await writeFile(join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n', 'utf8');
      assert.equal(detectGitRepo(wt), true, '.git as a plain file (linked worktree)');
    } finally {
      await rm(wt, { recursive: true, force: true });
    }

    // A directory outside any repository.
    assert.equal(detectGitRepo(outside), false, 'no repo above a bare temp dir');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

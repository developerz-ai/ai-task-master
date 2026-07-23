import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { makeTempRepo, type TempRepo } from '../testing/temp-repo.ts';
import { branchCleanupMessage, cleanupMergedBranches, cleanupSummary } from './branch-cleanup.ts';

// A repo on `main` with one commit and a bare origin, so remote deletion is exercised for real
// rather than mocked — the whole point of this module is what it does to actual refs.
async function seedRepo(): Promise<{
  repo: TempRepo;
  remote: string;
  cleanup: () => Promise<void>;
}> {
  const repo = await makeTempRepo();
  await execa('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo.path });
  await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo.path });
  const remote = await mkdtemp(join(tmpdir(), 'aitm-origin-'));
  await execa('git', ['init', '--bare', '--initial-branch=main', remote]);
  await execa('git', ['remote', 'add', 'origin', remote], { cwd: repo.path });
  await execa('git', ['push', 'origin', 'main'], { cwd: repo.path });
  return {
    repo,
    remote,
    cleanup: async () => {
      await repo.cleanup();
      await rm(remote, { recursive: true, force: true });
    },
  };
}

async function branches(cwd: string): Promise<string[]> {
  const { stdout } = await execa('git', ['branch', '--format=%(refname:short)'], { cwd });
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

async function remoteBranches(remote: string): Promise<string[]> {
  const { stdout } = await execa('git', ['branch', '--format=%(refname:short)'], { cwd: remote });
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

test('cleanupMergedBranches: deletes a merged branch locally and on origin', async () => {
  const { repo, remote, cleanup } = await seedRepo();
  try {
    await execa('git', ['checkout', '-b', 'aitm/G1'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'work'], { cwd: repo.path });
    await execa('git', ['push', 'origin', 'aitm/G1'], { cwd: repo.path });
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    const result = await cleanupMergedBranches({
      cwd: repo.path,
      baseBranch: 'main',
      mergedBranches: ['aitm/G1'],
    });

    assert.deepEqual(result.deleted, ['aitm/G1']);
    assert.deepEqual(result.remoteDeleted, ['aitm/G1'], 'remote deletion is recorded, not assumed');
    assert.deepEqual(await branches(repo.path), ['main']);
    assert.deepEqual(await remoteBranches(remote), ['main']);
    assert.equal(
      branchCleanupMessage('aitm/G1', result),
      'deleted merged branch aitm/G1 (local + origin)',
    );
  } finally {
    await cleanup();
  }
});

test('cleanupMergedBranches: moves HEAD off the branch it is about to delete', async () => {
  // The last group of a run always finishes standing on its own branch; without the switch the
  // delete is impossible and the operator is left parked on a merged branch.
  const { repo, cleanup } = await seedRepo();
  try {
    await execa('git', ['checkout', '-b', 'aitm/G5'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'work'], { cwd: repo.path });

    const result = await cleanupMergedBranches({
      cwd: repo.path,
      baseBranch: 'main',
      mergedBranches: ['aitm/G5'],
      deleteRemote: false,
    });

    assert.equal(result.switchedTo, 'main');
    assert.deepEqual(result.deleted, ['aitm/G5']);
    assert.equal(await currentBranch(repo.path), 'main');
  } finally {
    await cleanup();
  }
});

test('cleanupMergedBranches: a squash-merged branch is deleted even though it is not an ancestor', async () => {
  // aitm squash-merges, so git's own merged-check would refuse every branch it has ever landed.
  // The authority is the run state, which is why this uses -D.
  const { repo, cleanup } = await seedRepo();
  try {
    await execa('git', ['checkout', '-b', 'aitm/G2'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'unmerged work'], { cwd: repo.path });
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    const result = await cleanupMergedBranches({
      cwd: repo.path,
      baseBranch: 'main',
      mergedBranches: ['aitm/G2'],
      deleteRemote: false,
    });

    assert.deepEqual(result.deleted, ['aitm/G2']);
    assert.deepEqual(await branches(repo.path), ['main']);
  } finally {
    await cleanup();
  }
});

test('cleanupMergedBranches: touches nothing it was not given', async () => {
  // A blocked group's branch holds the only copy of its work — it must survive a sibling's cleanup.
  const { repo, cleanup } = await seedRepo();
  try {
    for (const name of ['aitm/G1', 'aitm/G2']) {
      await execa('git', ['checkout', '-b', name], { cwd: repo.path });
      await execa('git', ['commit', '--allow-empty', '-m', name], { cwd: repo.path });
    }
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    await cleanupMergedBranches({
      cwd: repo.path,
      baseBranch: 'main',
      mergedBranches: ['aitm/G1'],
      deleteRemote: false,
    });

    assert.deepEqual((await branches(repo.path)).sort(), ['aitm/G2', 'main']);
  } finally {
    await cleanup();
  }
});

test('cleanupMergedBranches: an empty list is a no-op', async () => {
  const { repo, cleanup } = await seedRepo();
  try {
    const result = await cleanupMergedBranches({
      cwd: repo.path,
      baseBranch: 'main',
      mergedBranches: [],
    });
    assert.deepEqual(result, { deleted: [], remoteDeleted: [], kept: [] });
    assert.deepEqual(await branches(repo.path), ['main']);
  } finally {
    await cleanup();
  }
});

test('cleanupMergedBranches: a branch that will not delete is reported kept, not silently dropped', async () => {
  const { repo, cleanup } = await seedRepo();
  try {
    const result = await cleanupMergedBranches({
      cwd: repo.path,
      baseBranch: 'main',
      mergedBranches: ['aitm/never-existed'],
      deleteRemote: false,
    });
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.kept, ['aitm/never-existed']);
  } finally {
    await cleanup();
  }
});

test('cleanupMergedBranches: a repo with no origin records no remote deletion', async () => {
  // The message must not claim "origin" when there was no remote to delete from.
  const repo = await makeTempRepo();
  try {
    await execa('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo.path });
    await execa('git', ['checkout', '-b', 'aitm/G1'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'work'], { cwd: repo.path });
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    const result = await cleanupMergedBranches({
      cwd: repo.path,
      baseBranch: 'main',
      mergedBranches: ['aitm/G1'],
    });

    assert.deepEqual(result.deleted, ['aitm/G1']);
    assert.deepEqual(result.remoteDeleted, [], 'no origin → nothing recorded as remote-deleted');
    assert.equal(
      branchCleanupMessage('aitm/G1', result),
      'deleted merged branch aitm/G1 (local; origin already gone or none)',
    );
  } finally {
    await repo.cleanup();
  }
});

test('branchCleanupMessage: never claims origin unless the remote delete really happened', () => {
  assert.equal(
    branchCleanupMessage('b', { deleted: ['b'], remoteDeleted: ['b'], kept: [] }),
    'deleted merged branch b (local + origin)',
  );
  assert.equal(
    branchCleanupMessage('b', { deleted: ['b'], remoteDeleted: [], kept: [] }),
    'deleted merged branch b (local; origin already gone or none)',
  );
  assert.equal(
    branchCleanupMessage('b', { deleted: [], remoteDeleted: ['b'], kept: [] }),
    'deleted merged branch b on origin; local delete failed (branch kept)',
  );
  assert.equal(
    branchCleanupMessage('b', { deleted: [], remoteDeleted: [], kept: ['b'] }),
    'merged branch b left in place (delete failed)',
  );
});

test('cleanupSummary: says what happened, and says nothing when nothing did', () => {
  assert.equal(cleanupSummary({ deleted: [], remoteDeleted: [], kept: [] }), '');
  assert.match(
    cleanupSummary({
      switchedTo: 'main',
      deleted: ['aitm/G1', 'aitm/G2'],
      remoteDeleted: [],
      kept: [],
    }),
    /back on main — deleted 2 merged branch\(es\): aitm\/G1, aitm\/G2/,
  );
});

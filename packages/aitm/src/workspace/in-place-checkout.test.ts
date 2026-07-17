import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { makeTempRepo, type TempRepo } from '../testing/temp-repo.ts';
import { InPlaceCheckout } from './in-place-checkout.ts';

async function seedRepo(): Promise<TempRepo> {
  const repo = await makeTempRepo();
  await execa('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo.path });
  await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo.path });
  return repo;
}

async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return stdout.trim();
}

// A working repo wired to a bare `origin` whose `main` holds one commit. `advanceOrigin` lands a
// further commit on origin/main from a throwaway clone (simulating a task's PR merging), so
// resetToBase can be shown to branch off the LATEST remote base.
async function seedRepoWithOrigin(): Promise<{
  repo: TempRepo;
  advanceOrigin: (subject: string) => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const repo = await seedRepo();
  const remote = await mkdtemp(join(tmpdir(), 'aitm-origin-'));
  await execa('git', ['init', '--bare', remote]);
  await execa('git', ['remote', 'add', 'origin', remote], { cwd: repo.path });
  await execa('git', ['push', 'origin', 'main'], { cwd: repo.path });
  const advanceOrigin = async (subject: string): Promise<void> => {
    const clone = await mkdtemp(join(tmpdir(), 'aitm-clone-'));
    await execa('git', ['clone', remote, clone]);
    await execa('git', ['config', 'user.email', 'test@aitm.local'], { cwd: clone });
    await execa('git', ['config', 'user.name', 'aitm-test'], { cwd: clone });
    await execa('git', ['commit', '--allow-empty', '-m', subject], { cwd: clone });
    await execa('git', ['push', 'origin', 'main'], { cwd: clone });
    await rm(clone, { recursive: true, force: true });
  };
  const cleanup = async (): Promise<void> => {
    await repo.cleanup();
    await rm(remote, { recursive: true, force: true });
  };
  return { repo, advanceOrigin, cleanup };
}

async function logSubjects(cwd: string): Promise<string[]> {
  const { stdout } = await execa('git', ['log', '--pretty=%s'], { cwd });
  return stdout.split('\n').map((s) => s.trim());
}

test('InPlaceCheckout is constructible', () => {
  assert.ok(new InPlaceCheckout('/tmp/repo') instanceof InPlaceCheckout);
});

test('acquire checks out a fresh branch in the repo root (no separate dir) and tracks it active', async () => {
  const repo = await seedRepo();
  try {
    const home = new InPlaceCheckout(repo.path);
    const wt = await home.acquire('g1', 'aitm/g1', 'main');
    assert.deepEqual(wt, { groupId: 'g1', branch: 'aitm/g1', path: repo.path });
    assert.equal(await currentBranch(repo.path), 'aitm/g1', 'HEAD is on the group branch');
    assert.equal(home.active().length, 1);
    assert.equal(home.active()[0]?.groupId, 'g1');
  } finally {
    await repo.cleanup();
  }
});

test('acquire is single-slot: a second group before release throws', async () => {
  const repo = await seedRepo();
  try {
    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    await assert.rejects(home.acquire('g2', 'aitm/g2', 'main'), /single-slot/);
  } finally {
    await repo.cleanup();
  }
});

test('release frees the slot so the next group can be checked out', async () => {
  const repo = await seedRepo();
  try {
    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    await home.release('g1');
    assert.equal(home.active().length, 0);
    const wt2 = await home.acquire('g2', 'aitm/g2', 'main');
    assert.equal(wt2.branch, 'aitm/g2');
    assert.equal(await currentBranch(repo.path), 'aitm/g2');
  } finally {
    await repo.cleanup();
  }
});

test('acquire reuses an existing branch (resume) instead of recreating it from base', async () => {
  const repo = await seedRepo();
  try {
    // Pre-create the branch with a commit that a naive `checkout -B <branch> main` would discard.
    await execa('git', ['checkout', '-b', 'aitm/g1'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'prior work'], { cwd: repo.path });
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    const { stdout } = await execa('git', ['log', '-1', '--pretty=%s'], { cwd: repo.path });
    assert.equal(
      stdout.trim(),
      'prior work',
      'existing branch + its commits are reused, not reset',
    );
  } finally {
    await repo.cleanup();
  }
});

test('acquire rejects an unsafe groupId', async () => {
  const home = new InPlaceCheckout('/tmp/repo');
  await assert.rejects(home.acquire('../evil', 'aitm/x', 'main'), /invalid groupId/);
});

test('resetToBase starts a fresh branch off the up-to-date remote base, discarding the prior branch tip', async () => {
  const { repo, advanceOrigin, cleanup } = await seedRepoWithOrigin();
  try {
    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    // Task 1's local work on the group branch — must NOT leak into the next task's branch.
    await execa('git', ['commit', '--allow-empty', '-m', 'task1 local'], { cwd: repo.path });
    // Task 1's PR squash-merges: origin/main advances past the group branch tip.
    await advanceOrigin('merged task1');

    const wt = await home.resetToBase('g1', 'aitm/g1-t2', 'main');

    assert.deepEqual(wt, { groupId: 'g1', branch: 'aitm/g1-t2', path: repo.path });
    assert.equal(await currentBranch(repo.path), 'aitm/g1-t2', 'HEAD is on the fresh task branch');
    const subjects = await logSubjects(repo.path);
    assert.equal(subjects[0], 'merged task1', 'the fresh branch is anchored on the merged base');
    assert.ok(
      !subjects.includes('task1 local'),
      'the prior branch tip is not carried into the fresh task branch',
    );
    assert.equal(home.active()[0]?.branch, 'aitm/g1-t2', 'active tracks the new branch');
  } finally {
    await cleanup();
  }
});

test('resetToBase rejects a different group while one is still checked out (single-slot)', async () => {
  const { repo, cleanup } = await seedRepoWithOrigin();
  try {
    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    await assert.rejects(home.resetToBase('g2', 'aitm/g2-t1', 'main'), /single-slot/);
  } finally {
    await cleanup();
  }
});

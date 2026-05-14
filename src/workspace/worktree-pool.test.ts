import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { makeTempRepo, type TempRepo } from '../testing/temp-repo.ts';
import { WorktreePool } from './worktree-pool.ts';

// `git worktree add ... -b <branch> <baseBranch>` requires a resolvable baseBranch,
// which after a bare `git init` doesn't exist. Force the initial branch name and
// land one empty commit so `main` is a real ref.
async function seedRepo(): Promise<TempRepo> {
  const repo = await makeTempRepo();
  await execa('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo.path });
  await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo.path });
  return repo;
}

test('WorktreePool is constructible', () => {
  const p = new WorktreePool('/tmp/repo', '/tmp/repo/.ai-task-master', 2);
  assert.ok(p instanceof WorktreePool);
});

test('acquire creates an isolated worktree on disk + tracks it as active', async () => {
  const repo = await seedRepo();
  const stateDir = join(repo.path, '.ai-task-master');
  const pool = new WorktreePool(repo.path, stateDir, 2);
  try {
    const wt = await pool.acquire('g1', 'aitm/r1/g1', 'main');

    assert.deepEqual(wt, {
      groupId: 'g1',
      branch: 'aitm/r1/g1',
      path: join(stateDir, 'worktrees', 'g1'),
    });
    assert.ok(existsSync(wt.path), 'worktree directory must exist');
    assert.strictEqual(pool.active().length, 1);
    assert.strictEqual(pool.active()[0]?.groupId, 'g1');

    const branches = await execa('git', ['branch', '--list'], { cwd: repo.path });
    assert.match(branches.stdout, /aitm\/r1\/g1/);
  } finally {
    await pool.releaseAll();
    await repo.cleanup();
  }
});

test('acquire blocks past maxConcurrent and resumes on release', async () => {
  const repo = await seedRepo();
  const stateDir = join(repo.path, '.ai-task-master');
  const pool = new WorktreePool(repo.path, stateDir, 1);
  try {
    const w1 = await pool.acquire('g1', 'aitm/r1/g1', 'main');
    assert.strictEqual(pool.active().length, 1);

    let secondResolved = false;
    const p2 = pool.acquire('g2', 'aitm/r1/g2', 'main').then((w) => {
      secondResolved = true;
      return w;
    });

    // 50ms is plenty for a same-process Promise to resolve if it were going to;
    // since maxConcurrent=1 and slot 1 is held, p2 must still be pending here.
    await new Promise<void>((r) => setTimeout(r, 50));
    assert.strictEqual(secondResolved, false, 'second acquire must wait for free slot');
    assert.strictEqual(pool.active().length, 1);

    await pool.release('g1');
    assert.ok(!existsSync(w1.path), 'first worktree path removed on release');

    const w2 = await p2;
    assert.strictEqual(secondResolved, true);
    assert.strictEqual(w2.groupId, 'g2');
    assert.ok(existsSync(w2.path));
    assert.strictEqual(pool.active().length, 1);

    const branches = await execa('git', ['branch', '--list'], { cwd: repo.path });
    assert.match(branches.stdout, /aitm\/r1\/g2/);
  } finally {
    await pool.releaseAll();
    await repo.cleanup();
  }
});

test('releaseAll removes every active worktree', async () => {
  const repo = await seedRepo();
  const stateDir = join(repo.path, '.ai-task-master');
  const pool = new WorktreePool(repo.path, stateDir, 3);
  try {
    const a = await pool.acquire('g1', 'aitm/r1/g1', 'main');
    const b = await pool.acquire('g2', 'aitm/r1/g2', 'main');
    assert.strictEqual(pool.active().length, 2);

    await pool.releaseAll();
    assert.strictEqual(pool.active().length, 0);
    assert.ok(!existsSync(a.path));
    assert.ok(!existsSync(b.path));

    // After releaseAll, capacity must be fully freed — another acquire works.
    const c = await pool.acquire('g3', 'aitm/r1/g3', 'main');
    assert.strictEqual(pool.active().length, 1);
    assert.ok(existsSync(c.path));
  } finally {
    await pool.releaseAll();
    await repo.cleanup();
  }
});

test('release is a no-op for unknown groupId', async () => {
  const repo = await seedRepo();
  const stateDir = join(repo.path, '.ai-task-master');
  const pool = new WorktreePool(repo.path, stateDir, 2);
  try {
    await pool.release('does-not-exist');
    assert.strictEqual(pool.active().length, 0);
  } finally {
    await repo.cleanup();
  }
});

test('acquire rejects duplicate groupId while still active', async () => {
  const repo = await seedRepo();
  const stateDir = join(repo.path, '.ai-task-master');
  const pool = new WorktreePool(repo.path, stateDir, 2);
  try {
    await pool.acquire('g1', 'aitm/r1/g1', 'main');
    await assert.rejects(() => pool.acquire('g1', 'aitm/r1/g1-bis', 'main'), /already acquired/);
  } finally {
    await pool.releaseAll();
    await repo.cleanup();
  }
});

test('acquire rejects groupId with path traversal segments', async () => {
  const pool = new WorktreePool('/tmp/repo', '/tmp/repo/.ai-task-master', 2);
  for (const bad of ['../escape', 'a/b', '..', '.', 'has space', 'has\\slash']) {
    await assert.rejects(() => pool.acquire(bad, 'br', 'main'), /invalid groupId/);
  }
  assert.strictEqual(pool.active().length, 0);
});

test('acquire rejects in-flight duplicate before git worktree add completes', async () => {
  const repo = await seedRepo();
  const stateDir = join(repo.path, '.ai-task-master');
  const pool = new WorktreePool(repo.path, stateDir, 2);
  try {
    const p1 = pool.acquire('g1', 'aitm/r1/g1', 'main');
    // The second acquire is dispatched before the first has resolved — it must see
    // the in-flight reservation, not race against `git worktree add`.
    await assert.rejects(() => pool.acquire('g1', 'aitm/r1/g1-bis', 'main'), /already acquired/);
    await p1;
  } finally {
    await pool.releaseAll();
    await repo.cleanup();
  }
});

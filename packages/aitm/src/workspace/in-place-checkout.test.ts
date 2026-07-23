import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { makeTempRepo, type TempRepo } from '../testing/temp-repo.ts';
import { DirtyWorkingTree } from './dirty-tree.ts';
import { hasTaskCommit, InPlaceCheckout } from './in-place-checkout.ts';
import { taskCommitTrailer } from './task-commit-marker.ts';

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
  // Pin the bare origin's default branch to main so a machine whose init.defaultBranch is master
  // (e.g. CI) still clones onto main in advanceOrigin — otherwise `git push origin main` there
  // fails with "src refspec main does not match any".
  await execa('git', ['init', '--bare', '--initial-branch=main', remote]);
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

test('acquire cleans a dirty tree (stale tracked edit) before switching, not carrying it forward', async () => {
  const repo = await seedRepo();
  try {
    await writeFile(join(repo.path, 'a.txt'), 'base\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'add a.txt'], { cwd: repo.path });

    const home = new InPlaceCheckout(repo.path);
    // The run enters on a clean tree; the dirt below is a crashed/blocked group's leftover, which
    // is what the between-group clean gate exists for.
    await home.acquire('g0', 'aitm/g0', 'main');
    await home.release('g0');
    await writeFile(join(repo.path, 'a.txt'), 'stale worker edit\n');

    await home.acquire('g1', 'aitm/g1', 'main');

    assert.equal(await currentBranch(repo.path), 'aitm/g1');
    assert.equal(
      await readFile(join(repo.path, 'a.txt'), 'utf8'),
      'base\n',
      'the stale edit is reset, not carried onto the new branch',
    );
    const { stdout } = await execa('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repo.path,
    });
    assert.equal(stdout.trim(), '', 'the new group branch starts on a clean tree');
  } finally {
    await repo.cleanup();
  }
});

test('acquire removes untracked leftovers from a prior group but preserves .ai-task-master state', async () => {
  const repo = await seedRepo();
  try {
    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    await home.release('g1');
    // A prior group's editors created a new file but its verify gate stayed red, so it was never
    // committed — it lingers UNTRACKED in the shared tree. And aitm's own state dir sits at the root.
    await writeFile(join(repo.path, 'leftover.ts'), 'export const leaked = 1;\n');
    await mkdir(join(repo.path, '.ai-task-master'), { recursive: true });
    await writeFile(join(repo.path, '.ai-task-master', 'state.json'), '{"keep":true}\n');

    await home.acquire('g2', 'aitm/g2', 'main');

    assert.equal(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
      '{"keep":true}\n',
      "aitm's own state dir must survive the clean gate",
    );
    const leftoverGone = await readFile(join(repo.path, 'leftover.ts'), 'utf8').then(
      () => false,
      () => true,
    );
    assert.ok(leftoverGone, "a prior group's untracked file must not survive onto the next branch");
    const { stdout } = await execa('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repo.path,
    });
    assert.equal(stdout.trim(), '', 'the new group branch starts on a clean tree');
  } finally {
    await repo.cleanup();
  }
});

test('acquire clean gate keeps a resumed branch commit while dropping stale edits', async () => {
  const repo = await seedRepo();
  try {
    await writeFile(join(repo.path, 'a.txt'), 'base\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'add a.txt'], { cwd: repo.path });
    // Committed-but-unpushed work on the group branch that a resume must keep.
    await execa('git', ['checkout', '-b', 'aitm/g1'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'prior work'], { cwd: repo.path });
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g0', 'aitm/g0', 'main');
    await home.release('g0');
    // Stale uncommitted edit sitting on the tree when the resumed acquire runs.
    await writeFile(join(repo.path, 'a.txt'), 'stale\n');

    await home.acquire('g1', 'aitm/g1', 'main');

    const { stdout } = await execa('git', ['log', '-1', '--pretty=%s'], { cwd: repo.path });
    assert.equal(stdout.trim(), 'prior work', 'the resumed branch commit survives the clean gate');
    assert.equal(await readFile(join(repo.path, 'a.txt'), 'utf8'), 'base\n', 'stale edit dropped');
  } finally {
    await repo.cleanup();
  }
});

// ---- Run-entry dirty-tree guard -------------------------------------------
// Between groups the dirt is aitm's own and gets cleaned (tests above). At run entry it is the
// operator's uncommitted work, indistinguishable from that junk, so the run refuses instead.

test('acquire refuses on a dirty tree at run entry, leaving the work and HEAD untouched', async () => {
  const repo = await seedRepo();
  try {
    await writeFile(join(repo.path, 'a.txt'), 'committed\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'add a.txt'], { cwd: repo.path });
    // The operator's in-progress work: one tracked edit, one untracked file.
    await writeFile(join(repo.path, 'a.txt'), 'work in progress\n');
    await writeFile(join(repo.path, 'notes.md'), '# scratch\n');

    const home = new InPlaceCheckout(repo.path);
    await assert.rejects(
      () => home.acquire('g1', 'aitm/g1', 'main'),
      (err: unknown) => {
        assert.ok(
          err instanceof DirtyWorkingTree,
          'refusal is typed so the loop can abort the run',
        );
        assert.match(err.message, /a\.txt/);
        assert.match(err.message, /notes\.md/);
        assert.match(err.message, /--allow-dirty/);
        return true;
      },
    );

    assert.equal(
      await readFile(join(repo.path, 'a.txt'), 'utf8'),
      'work in progress\n',
      'the tracked edit survives the refusal',
    );
    assert.equal(await readFile(join(repo.path, 'notes.md'), 'utf8'), '# scratch\n');
    assert.equal(await currentBranch(repo.path), 'main', 'HEAD never moved');
    assert.equal(home.active().length, 0, 'no slot is taken by a refused acquire');
  } finally {
    await repo.cleanup();
  }
});

test('acquire refusal is re-checked: committing the work then retrying succeeds', async () => {
  const repo = await seedRepo();
  try {
    await writeFile(join(repo.path, 'a.txt'), 'work in progress\n');

    const home = new InPlaceCheckout(repo.path);
    await assert.rejects(() => home.acquire('g1', 'aitm/g1', 'main'), DirtyWorkingTree);

    await execa('git', ['add', 'a.txt'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'save my work'], { cwd: repo.path });

    const wt = await home.acquire('g1', 'aitm/g1', 'main');
    assert.equal(wt.branch, 'aitm/g1');
    assert.equal(await readFile(join(repo.path, 'a.txt'), 'utf8'), 'work in progress\n');
  } finally {
    await repo.cleanup();
  }
});

test('acquire with allowDirty discards pre-existing work instead of refusing', async () => {
  const repo = await seedRepo();
  try {
    await writeFile(join(repo.path, 'a.txt'), 'committed\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'add a.txt'], { cwd: repo.path });
    await writeFile(join(repo.path, 'a.txt'), 'work in progress\n');
    await writeFile(join(repo.path, 'notes.md'), '# scratch\n');

    const home = new InPlaceCheckout(repo.path, { allowDirty: true });
    await home.acquire('g1', 'aitm/g1', 'main');

    assert.equal(await currentBranch(repo.path), 'aitm/g1');
    assert.equal(await readFile(join(repo.path, 'a.txt'), 'utf8'), 'committed\n');
    const untrackedGone = await readFile(join(repo.path, 'notes.md'), 'utf8').then(
      () => false,
      () => true,
    );
    assert.ok(untrackedGone, 'the opt-out is explicit consent to lose the untracked file too');
  } finally {
    await repo.cleanup();
  }
});

test("acquire does not refuse over aitm's own state dir at run entry", async () => {
  const repo = await seedRepo();
  try {
    // A repo that does not gitignore the state dir shows it as untracked on the very first
    // acquire — the run's own bookkeeping must not read as the operator's work.
    await mkdir(join(repo.path, '.ai-task-master'), { recursive: true });
    await writeFile(join(repo.path, '.ai-task-master', 'state.json'), '{"keep":true}\n');

    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');

    assert.equal(await currentBranch(repo.path), 'aitm/g1');
    assert.equal(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
      '{"keep":true}\n',
    );
  } finally {
    await repo.cleanup();
  }
});

test('resetToBase refuses on a dirty tree at run entry too (the other slot-taking call)', async () => {
  const { repo, cleanup } = await seedRepoWithOrigin();
  try {
    await writeFile(join(repo.path, 'notes.md'), '# scratch\n');

    const home = new InPlaceCheckout(repo.path);
    await assert.rejects(() => home.resetToBase('g1', 'aitm/g1-t1', 'main'), DirtyWorkingTree);

    assert.equal(await readFile(join(repo.path, 'notes.md'), 'utf8'), '# scratch\n');
    assert.equal(await currentBranch(repo.path), 'main');
  } finally {
    await cleanup();
  }
});

test('resetToBase cleans a dirty tree so the fresh-base switch is not blocked or contaminated', async () => {
  const { repo, cleanup } = await seedRepoWithOrigin();
  try {
    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    // A tracked file committed on the task branch, then left with an uncommitted edit that WOULD
    // abort `checkout -B <fresh> origin/main` (local changes overwritten) without the clean gate.
    await writeFile(join(repo.path, 'a.txt'), 'base\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'add a.txt'], { cwd: repo.path });
    await writeFile(join(repo.path, 'a.txt'), 'dirty\n');

    const wt = await home.resetToBase('g1', 'aitm/g1-t2', 'main');

    assert.equal(wt.branch, 'aitm/g1-t2');
    assert.equal(await currentBranch(repo.path), 'aitm/g1-t2');
    const { stdout } = await execa('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repo.path,
    });
    assert.equal(stdout.trim(), '', 'the fresh task branch starts clean');
  } finally {
    await cleanup();
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

// ---------------------------------------------------------------------------
// hasTaskCommit — the duplicate task-commit-on-resume detector
// ---------------------------------------------------------------------------

test('hasTaskCommit: false when the branch has no commit carrying the task trailer', async () => {
  const repo = await seedRepo();
  try {
    await execa('git', ['checkout', '-b', 'aitm/g1'], { cwd: repo.path });
    await execa('git', ['commit', '--allow-empty', '-m', 'unrelated work'], { cwd: repo.path });
    assert.equal(await hasTaskCommit(repo.path, 'aitm/g1', 't1'), false);
  } finally {
    await repo.cleanup();
  }
});

test('hasTaskCommit: false when the branch does not exist at all', async () => {
  const repo = await seedRepo();
  try {
    assert.equal(await hasTaskCommit(repo.path, 'aitm/never-acquired', 't1'), false);
  } finally {
    await repo.cleanup();
  }
});

test('hasTaskCommit: true once a commit stamped with the task trailer lands on the branch', async () => {
  const repo = await seedRepo();
  try {
    await execa('git', ['checkout', '-b', 'aitm/g1'], { cwd: repo.path });
    const message = `feat: add hello\n\n${taskCommitTrailer('t1')}`;
    await execa('git', ['commit', '--allow-empty', '-m', message], { cwd: repo.path });
    assert.equal(await hasTaskCommit(repo.path, 'aitm/g1', 't1'), true);
    assert.equal(
      await hasTaskCommit(repo.path, 'aitm/g1', 't2'),
      false,
      'a different task id on the same branch must not match',
    );
  } finally {
    await repo.cleanup();
  }
});

test('hasTaskCommit: a t1 trailer does not match a t10 task id (full-line, not substring)', async () => {
  const repo = await seedRepo();
  try {
    await execa('git', ['checkout', '-b', 'aitm/g1'], { cwd: repo.path });
    // Only t10's trailer is on the branch. A substring grep for `Aitm-Task-Id: t1` would match it.
    const message = `feat: add tenth\n\n${taskCommitTrailer('t10')}`;
    await execa('git', ['commit', '--allow-empty', '-m', message], { cwd: repo.path });
    assert.equal(
      await hasTaskCommit(repo.path, 'aitm/g1', 't1'),
      false,
      't1 must not match the t10 trailer line',
    );
    assert.equal(
      await hasTaskCommit(repo.path, 'aitm/g1', 't10'),
      true,
      't10 matches its own complete trailer line',
    );
  } finally {
    await repo.cleanup();
  }
});

test('InPlaceCheckout.hasTaskCommit: reachable as a CheckoutHome method, same result as the free function', async () => {
  const repo = await seedRepo();
  try {
    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    const message = `feat: add hello\n\n${taskCommitTrailer('t1')}`;
    await execa('git', ['commit', '--allow-empty', '-m', message], { cwd: repo.path });
    assert.equal(await home.hasTaskCommit('aitm/g1', 't1'), true);
    assert.equal(await home.hasTaskCommit('aitm/g1', 't2'), false);
  } finally {
    await repo.cleanup();
  }
});

// Regression for issue #247: a sibling group's PR squash-merges REMOTELY (gh), so the local base
// ref is stale when the next group acquires. A new group branch must include the merged work.
test('acquire branches a NEW group off the up-to-date remote base, not the stale local ref', async () => {
  const { repo, advanceOrigin, cleanup } = await seedRepoWithOrigin();
  try {
    await advanceOrigin('sibling group merged');
    const home = new InPlaceCheckout(repo.path);
    const co = await home.acquire('g2', 'aitm/g2', 'main');
    assert.equal(co.branch, 'aitm/g2');
    assert.equal(await currentBranch(repo.path), 'aitm/g2');
    assert.ok(
      (await logSubjects(repo.path)).includes('sibling group merged'),
      'the new group branch carries the remotely-merged sibling work',
    );
  } finally {
    await cleanup();
  }
});

test('acquire without an origin remote still branches off the local base ref', async () => {
  const repo = await seedRepo();
  try {
    const home = new InPlaceCheckout(repo.path);
    const co = await home.acquire('g1', 'aitm/g1', 'main');
    assert.equal(co.branch, 'aitm/g1');
    assert.equal(await currentBranch(repo.path), 'aitm/g1');
    assert.ok(
      (await logSubjects(repo.path)).includes('init'),
      'local base history is the start point',
    );
  } finally {
    await repo.cleanup();
  }
});

test('acquire reuses an existing group branch without touching the remote base (resume path)', async () => {
  const { repo, advanceOrigin, cleanup } = await seedRepoWithOrigin();
  try {
    const home = new InPlaceCheckout(repo.path);
    await home.acquire('g1', 'aitm/g1', 'main');
    await execa('git', ['commit', '--allow-empty', '-m', 'unpushed group work'], {
      cwd: repo.path,
    });
    await home.release('g1');
    await advanceOrigin('later remote merge');
    const co = await home.acquire('g1', 'aitm/g1', 'main');
    assert.equal(co.branch, 'aitm/g1');
    const subjects = await logSubjects(repo.path);
    assert.ok(subjects.includes('unpushed group work'), 'resumed branch keeps its committed work');
    assert.ok(
      !subjects.includes('later remote merge'),
      'resume reuses the branch as-is instead of rebuilding it from base',
    );
  } finally {
    await cleanup();
  }
});

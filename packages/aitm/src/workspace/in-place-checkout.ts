// The one and only execution home. Subagents work directly in the current repo checkout on the
// current branch, coordinated by switching branches with `git checkout -B`. There is no isolated
// per-group directory — `path` is always the repo root.
//
// It is single-slot BY DESIGN: a working tree can only have one branch checked out, so two groups
// cannot run at once. The adapter forces concurrency to 1 — the team of subagents (worker → editor
// → reviewer) is *scheduled* sequentially so they never trample each other's edits. See
// src/loop/work-loop.ts.
//
// docs/runtime.md (uses execa, never Bun.$)

import { ExecaError } from 'execa';
import { runGit } from './git-exec.ts';
import { taskCommitTrailer } from './task-commit-marker.ts';

export type Checkout = {
  groupId: string;
  branch: string;
  path: string;
};

// Restrict groupId to characters safe as a single path segment so a branch name derived from it
// can't smuggle in git ref trickery. Branch validity itself is enforced upstream in
// args.ts#isValidBranchName; this is defense in depth at the exec boundary.
const SAFE_GROUP_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeGroupId(groupId: string): void {
  if (!SAFE_GROUP_ID.test(groupId) || groupId === '.' || groupId === '..') {
    throw new Error(`invalid groupId: ${groupId}`);
  }
}

// True when a local branch ref already exists — e.g. a resumed run whose group branch (and its
// committed-but-unpushed work) survived. `git rev-parse --verify --quiet` exits 1 with no output
// when (and only when) the ref is absent; any other failure (not a repo, permissions, git missing)
// is a real error and must propagate, not be read as "no branch".
export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot });
    return true;
  } catch (err) {
    if (err instanceof ExecaError && err.exitCode === 1) return false;
    throw err;
  }
}

// True when a commit on `branch` already carries this task's trailer (see task-commit-marker.ts) —
// a resumed run whose crash landed the Worker's commit (finalizeCommit) but died before WorkLoop
// persisted the task as done. Scoped to `branch`'s own history via `git log <branch>` so the grep
// can only match a commit aitm itself made for this task, never one on an unrelated ref. A missing
// branch (never acquired, or a fresh group) trivially has no such commit.
export async function hasTaskCommit(
  repoRoot: string,
  branch: string,
  taskId: string,
): Promise<boolean> {
  if (!(await branchExists(repoRoot, branch))) return false;
  const trailer = taskCommitTrailer(taskId);
  // `--grep` with `--fixed-strings` is a SUBSTRING match, so grepping for `Aitm-Task-Id: t1` also
  // matches a `Aitm-Task-Id: t10` trailer and a resumed run would skip the wrong task. Use the grep
  // only to narrow candidates (fast, branch-scoped), then confirm at least one carries the trailer
  // as a COMPLETE line so `t1` never matches `t10` (see the t1/t10 regression test). Bodies are
  // NUL-delimited so a multi-line message can't blur the commit boundary.
  const { stdout } = await runGit(
    ['log', branch, '--fixed-strings', `--grep=${trailer}`, '--format=%B%x00'],
    { cwd: repoRoot },
  );
  return stdout
    .split('\0')
    .some((body) => body.split('\n').some((line) => line.trim() === trailer));
}

export class InPlaceCheckout {
  // The one group currently checked out. Single-slot: a second concurrent acquire is a wiring bug
  // (concurrency should be 1), surfaced loudly rather than silently corrupting the tree.
  private current: Checkout | null = null;

  constructor(private readonly repoRoot: string) {}

  async acquire(groupId: string, branch: string, baseBranch: string): Promise<Checkout> {
    assertSafeGroupId(groupId);
    if (this.current !== null && this.current.groupId !== groupId) {
      throw new Error(
        `in-place checkout is single-slot: group ${this.current.groupId} is still checked out (set concurrency to 1)`,
      );
    }
    await this.ensureCleanTree();
    // Reuse an existing group branch (a resumed run whose committed-but-unpushed work survives on the
    // branch) rather than recreating it from base. A brand-new group starts a fresh branch off base
    // with `-B` so a retry after a half-done checkout is idempotent.
    const args = (await branchExists(this.repoRoot, branch))
      ? ['checkout', branch]
      : ['checkout', '-B', branch, baseBranch];
    await runGit(args, { cwd: this.repoRoot });
    const co: Checkout = { groupId, branch, path: this.repoRoot };
    this.current = co;
    return co;
  }

  // Start a FRESH branch off the up-to-date remote base, discarding whatever is checked out. prPerTask
  // (autoMerge) uses this between tasks: after task N's PR squash-merges, task N+1 must branch off the
  // MERGED base — not task N's tip — or its PR re-includes task N's changes (the prior tip is not an
  // ancestor of the squash commit). Fetches origin/<baseBranch>, then `checkout -B <branch>
  // origin/<baseBranch>`. Single-slot like acquire: a different group still checked out is a wiring bug.
  async resetToBase(groupId: string, branch: string, baseBranch: string): Promise<Checkout> {
    assertSafeGroupId(groupId);
    if (this.current !== null && this.current.groupId !== groupId) {
      throw new Error(
        `in-place checkout is single-slot: group ${this.current.groupId} is still checked out (set concurrency to 1)`,
      );
    }
    await this.ensureCleanTree();
    await runGit(['fetch', 'origin', baseBranch], { cwd: this.repoRoot });
    await runGit(['checkout', '-B', branch, `origin/${baseBranch}`], { cwd: this.repoRoot });
    const co: Checkout = { groupId, branch, path: this.repoRoot };
    this.current = co;
    return co;
  }

  // Drop stale uncommitted edits before switching branches. A crashed or blocked prior group can
  // leave junk in the shared tree; `git checkout` would carry it onto the next group's branch
  // (contamination) or abort the switch. Two kinds of junk, both cleaned:
  //   - modified/deleted TRACKED files → `git reset --hard` restores them to HEAD. Committed work is
  //     untouched (HEAD does not move), so a resumed branch's saved commits survive.
  //   - UNTRACKED files a prior group's editors created but never committed (its verify gate stayed
  //     red, or it crashed) → `git clean -fd` removes them, so the worker's `git add -A` can't sweep
  //     them into the NEXT group's commit and ship a foreign file in its PR.
  // aitm's own `.ai-task-master/` state dir must survive: `git clean` skips gitignored paths (no
  // `-x`), which covers the common case, and `-e .ai-task-master` protects it when the target repo
  // does not ignore it. Gitignored build output (node_modules/, dist/) is likewise preserved.
  private async ensureCleanTree(): Promise<void> {
    const { stdout } = await runGit(['status', '--porcelain'], { cwd: this.repoRoot });
    // Any dirty entry EXCEPT the state dir itself means there is something to clean.
    const dirty = stdout
      .split('\n')
      .some((line) => line.trim() !== '' && !line.slice(3).startsWith('.ai-task-master'));
    if (!dirty) return;
    await runGit(['reset', '--hard'], { cwd: this.repoRoot });
    await runGit(['clean', '-fd', '-e', '.ai-task-master'], { cwd: this.repoRoot });
  }

  // CheckoutHome.hasTaskCommit — see the free function above for the detection logic.
  async hasTaskCommit(branch: string, taskId: string): Promise<boolean> {
    return hasTaskCommit(this.repoRoot, branch, taskId);
  }

  async release(groupId: string): Promise<void> {
    // No dir to remove — just free the slot. HEAD stays on the group branch; the next acquire
    // switches to its own branch. aitm never needs the base checked out between groups.
    if (this.current?.groupId === groupId) this.current = null;
  }

  async releaseAll(): Promise<void> {
    this.current = null;
  }

  active(): ReadonlyArray<Checkout> {
    return this.current === null ? [] : [this.current];
  }
}

// No-worktree execution home. Instead of an isolated `git worktree` per group, subagents work
// directly in the ONE repo checkout, coordinated by switching branches with `git checkout -B`.
// Satisfies the same surface as WorktreePool (acquire/release → Worktree) so it drops into the
// WorkLoop unchanged, but `path` is always the repo root.
//
// It is single-slot BY DESIGN: a working tree can only have one branch checked out, so two groups
// cannot run at once. The adapter forces concurrency to 1 when this home is selected — the team of
// subagents (worker → editor → reviewer) is *scheduled* sequentially so they never trample each
// other's edits, which is the isolation a worktree otherwise buys. See src/loop/work-loop.ts.

import { runGit } from './git-exec.ts';
import { branchExists, type Worktree } from './worktree-pool.ts';

// Same single-path-segment guard WorktreePool applies to a group id, kept here so a branch name
// derived from it can't smuggle in git ref trickery. Branch validity itself is enforced upstream in
// args.ts#isValidBranchName; this is defense in depth at the exec boundary.
const SAFE_GROUP_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeGroupId(groupId: string): void {
  if (!SAFE_GROUP_ID.test(groupId) || groupId === '.' || groupId === '..') {
    throw new Error(`invalid groupId: ${groupId}`);
  }
}

export class InPlaceCheckout {
  // The one group currently checked out. Single-slot: a second concurrent acquire is a wiring bug
  // (concurrency should be 1), surfaced loudly rather than silently corrupting the tree.
  private current: Worktree | null = null;

  constructor(private readonly repoRoot: string) {}

  async acquire(groupId: string, branch: string, baseBranch: string): Promise<Worktree> {
    assertSafeGroupId(groupId);
    if (this.current !== null && this.current.groupId !== groupId) {
      throw new Error(
        `in-place checkout is single-slot: group ${this.current.groupId} is still checked out (set concurrency to 1)`,
      );
    }
    // Reuse an existing group branch (a resumed run whose committed-but-unpushed work survives on the
    // branch) rather than recreating it from base — mirrors WorktreePool. A brand-new group starts a
    // fresh branch off base with `-B` so a retry after a half-done checkout is idempotent.
    const args = (await branchExists(this.repoRoot, branch))
      ? ['checkout', branch]
      : ['checkout', '-B', branch, baseBranch];
    await runGit(args, { cwd: this.repoRoot });
    const wt: Worktree = { groupId, branch, path: this.repoRoot };
    this.current = wt;
    return wt;
  }

  // Start a FRESH branch off the up-to-date remote base, discarding whatever is checked out. prPerTask
  // (autoMerge) uses this between tasks: after task N's PR squash-merges, task N+1 must branch off the
  // MERGED base — not task N's tip — or its PR re-includes task N's changes (the prior tip is not an
  // ancestor of the squash commit). Fetches origin/<baseBranch>, then `checkout -B <branch>
  // origin/<baseBranch>`. Single-slot like acquire: a different group still checked out is a wiring bug.
  async resetToBase(groupId: string, branch: string, baseBranch: string): Promise<Worktree> {
    assertSafeGroupId(groupId);
    if (this.current !== null && this.current.groupId !== groupId) {
      throw new Error(
        `in-place checkout is single-slot: group ${this.current.groupId} is still checked out (set concurrency to 1)`,
      );
    }
    await runGit(['fetch', 'origin', baseBranch], { cwd: this.repoRoot });
    await runGit(['checkout', '-B', branch, `origin/${baseBranch}`], { cwd: this.repoRoot });
    const wt: Worktree = { groupId, branch, path: this.repoRoot };
    this.current = wt;
    return wt;
  }

  async release(groupId: string): Promise<void> {
    // No dir to remove — just free the slot. HEAD stays on the group branch; the next acquire
    // switches to its own branch. aitm never needs the base checked out between groups.
    if (this.current?.groupId === groupId) this.current = null;
  }

  async releaseAll(): Promise<void> {
    this.current = null;
  }

  active(): ReadonlyArray<Worktree> {
    return this.current === null ? [] : [this.current];
  }
}

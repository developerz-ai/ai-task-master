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
    await runGit(['fetch', 'origin', baseBranch], { cwd: this.repoRoot });
    await runGit(['checkout', '-B', branch, `origin/${baseBranch}`], { cwd: this.repoRoot });
    const co: Checkout = { groupId, branch, path: this.repoRoot };
    this.current = co;
    return co;
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

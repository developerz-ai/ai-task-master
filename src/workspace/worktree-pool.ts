// Concurrent Workers cannot share the same git working tree without trampling each other.
// WorktreePool issues an isolated `git worktree` per active group under
// .ai-task-master/worktrees/<group-id>/. On release, the worktree is removed.
//
// docs/state.md (state dir layout — `worktrees/` is a new subtree added for concurrent runs)
// docs/task-groups.md §Branching (branch naming: aitm/<runId>/<group.id>)
// docs/runtime.md (uses execa, never Bun.$)

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

export type Worktree = {
  groupId: string;
  branch: string;
  path: string;
};

export class WorktreePool {
  private readonly worktrees = new Map<string, Worktree>();
  private readonly waiters: Array<() => void> = [];
  // `reserved` covers both checked-out worktrees AND acquires that have passed the
  // gate but not yet completed `git worktree add`. Without this, two concurrent
  // acquire() calls could both pass `worktrees.size < maxConcurrent` and exceed the cap.
  private reserved = 0;

  constructor(
    private readonly repoRoot: string,
    private readonly stateDir: string,
    private readonly maxConcurrent: number,
  ) {}

  async acquire(groupId: string, branch: string, baseBranch: string): Promise<Worktree> {
    if (this.worktrees.has(groupId)) {
      throw new Error(`worktree already acquired for group ${groupId}`);
    }
    await this.reserveSlot();
    const worktreesDir = join(this.stateDir, 'worktrees');
    const path = join(worktreesDir, groupId);
    try {
      await mkdir(worktreesDir, { recursive: true });
      await execa('git', ['worktree', 'add', path, '-b', branch, baseBranch], {
        cwd: this.repoRoot,
      });
    } catch (err) {
      this.freeSlot();
      throw err;
    }
    const wt: Worktree = { groupId, branch, path };
    this.worktrees.set(groupId, wt);
    return wt;
  }

  async release(groupId: string): Promise<void> {
    const wt = this.worktrees.get(groupId);
    if (!wt) return;
    this.worktrees.delete(groupId);
    try {
      await execa('git', ['worktree', 'remove', '--force', wt.path], { cwd: this.repoRoot });
    } finally {
      this.freeSlot();
    }
  }

  async releaseAll(): Promise<void> {
    const ids = Array.from(this.worktrees.keys());
    for (const id of ids) {
      await this.release(id);
    }
  }

  active(): ReadonlyArray<Worktree> {
    return Array.from(this.worktrees.values());
  }

  private async reserveSlot(): Promise<void> {
    if (this.reserved < this.maxConcurrent) {
      this.reserved++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // Slot was transferred from a releaser via freeSlot(); `reserved` is unchanged.
  }

  private freeSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.reserved--;
  }
}

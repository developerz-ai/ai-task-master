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

// Restrict groupId to characters safe as a single path segment so `join(worktreesDir,
// groupId)` cannot escape into a parent directory and `release()`'s force-remove of
// the computed path cannot reach outside `worktrees/`.
const SAFE_GROUP_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeGroupId(groupId: string): void {
  if (!SAFE_GROUP_ID.test(groupId) || groupId === '.' || groupId === '..') {
    throw new Error(`invalid groupId: ${groupId}`);
  }
}

export class WorktreePool {
  private readonly worktrees = new Map<string, Worktree>();
  // `pendingGroupIds` covers acquires that have passed the duplicate check but not yet
  // completed `git worktree add`. Without it, two concurrent `acquire(g1, ...)` calls
  // could both pass the `worktrees.has` gate and race in `git worktree add`.
  private readonly pendingGroupIds = new Set<string>();
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
    assertSafeGroupId(groupId);
    if (this.worktrees.has(groupId) || this.pendingGroupIds.has(groupId)) {
      throw new Error(`worktree already acquired for group ${groupId}`);
    }
    this.pendingGroupIds.add(groupId);
    await this.reserveSlot();
    const worktreesDir = join(this.stateDir, 'worktrees');
    const path = join(worktreesDir, groupId);
    try {
      await mkdir(worktreesDir, { recursive: true });
      await execa('git', ['worktree', 'add', path, '-b', branch, baseBranch], {
        cwd: this.repoRoot,
      });
      const wt: Worktree = { groupId, branch, path };
      this.worktrees.set(groupId, wt);
      return wt;
    } catch (err) {
      this.freeSlot();
      throw err;
    } finally {
      this.pendingGroupIds.delete(groupId);
    }
  }

  async release(groupId: string): Promise<void> {
    const wt = this.worktrees.get(groupId);
    if (!wt) return;
    // Don't drop tracking until `git worktree remove` succeeds: a failed cleanup must
    // remain re-tryable via `release(groupId)`, and the slot must stay reserved so the
    // pool doesn't overbook after an untracked worktree is left on disk.
    await execa('git', ['worktree', 'remove', '--force', wt.path], { cwd: this.repoRoot });
    this.worktrees.delete(groupId);
    this.freeSlot();
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

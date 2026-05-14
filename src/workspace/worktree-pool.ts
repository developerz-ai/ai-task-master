// Concurrent Workers cannot share the same git working tree without trampling each other.
// WorktreePool issues an isolated `git worktree` per active group under
// .ai-task-master/worktrees/<group-id>/. On release, the worktree is removed.
//
// docs/state.md (state dir layout — `worktrees/` is a new subtree added for concurrent runs)
// docs/task-groups.md §Branching (branch naming: aitm/<runId>/<group.id>)
// docs/runtime.md (uses execa, never Bun.$)

export type Worktree = {
  groupId: string;
  branch: string;
  path: string;
};

export class WorktreePool {
  constructor(
    private readonly repoRoot: string,
    private readonly stateDir: string,
    private readonly maxConcurrent: number,
  ) {}

  // Acquire (create-or-checkout) a worktree for groupId rooted at baseBranch.
  // Blocks (queues) when maxConcurrent worktrees are already checked out.
  async acquire(_groupId: string, _branch: string, _baseBranch: string): Promise<Worktree> {
    throw new Error('not implemented');
  }

  async release(_groupId: string): Promise<void> {
    throw new Error('not implemented');
  }

  async releaseAll(): Promise<void> {
    throw new Error('not implemented');
  }

  active(): ReadonlyArray<Worktree> {
    throw new Error('not implemented');
  }
}

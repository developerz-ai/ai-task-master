// The Worker's output contract. Shared leaf type: the Worker produces it, the Orchestrator composes
// commit/PR text from it, and state/rolling-context summarizes it into context.md — so the shape lives
// here, below all three, rather than in subagents/worker.ts where it pulled state → subagents into a
// cycle.

// Per-file outcome from the parallel editor fanout. Useful to the Orchestrator
// when composing the PR body and the (possibly squashed) commit message.
export type FileChange = {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  summary: string;
};

export type WorkerDelivery = {
  branch: string;
  // Draft message Worker proposes; Orchestrator may rewrite before committing the final.
  draftCommitMessage: string;
  changes: FileChange[];
  // Per-task progress entries appended to .ai-task-master/progress.md.
  progressEntries: string[];
};

// docs/plans/2026/07/18/101-parallel-agent-bug-hunt/03-review-loop-idempotency.md — duplicate
// task-commit on resume (durability #7). A crash between the Worker's commit landing
// (orchestrator.ts finalizeCommit) and WorkLoop persisting the task as done leaves the branch with
// the commit but state.json still showing the task undone; a naive resume re-runs the Worker and
// doubles the commit (harmless under squash-merge, wrong under merge/rebase, which don't collapse
// history). This trailer is the deterministic marker that closes the gap: finalizeCommit stamps it
// onto every task commit, and InPlaceCheckout.hasTaskCommit greps `git log` for it on resume so
// WorkLoop.runOneTask can skip straight to marking the task done instead of re-running the Worker.
const TRAILER_KEY = 'Aitm-Task-Id';

export function taskCommitTrailer(taskId: string): string {
  return `${TRAILER_KEY}: ${taskId}`;
}

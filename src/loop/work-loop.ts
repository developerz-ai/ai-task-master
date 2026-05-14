// docs/architecture.md (WorkLoop row), docs/commands/start.md §Flow
// Drives the Orchestrator group-by-group. Extended for concurrent execution:
//
//   while !plan.isComplete():
//     ready = planGraph.ready()
//     batch = ready.slice(0, free worker slots)
//     await Promise.all(batch.map(g => runGroup(g)))
//
// Each runGroup acquires a WorktreePool slot, runs Worker, and on PR open hands off to
// the merge-pr flow (CI wait + Reviewer + GitHubClient.mergePr).

import type { GitHubClient } from '../github/github-client.ts';
import type { Orchestrator } from '../orchestrator/orchestrator.ts';
import type { PlanGraph } from '../plan/plan-graph.ts';
import type { PrGroup } from '../state/schema.ts';
import type { StateStore } from '../state/state-store.ts';
import type { WorktreePool } from '../workspace/worktree-pool.ts';

export type WorkLoopDeps = {
  orchestrator: Orchestrator;
  github: GitHubClient;
  state: StateStore;
  pool: WorktreePool;
  graph: PlanGraph;
  concurrency: number;
  autoMerge: boolean;
  maxSessions: number | null;
};

export type WorkLoopResult =
  | { kind: 'success' }
  | { kind: 'awaiting-pr'; prs: number[] } // --no-automerge exit path
  | { kind: 'blocked'; reason: string }
  | { kind: 'session-cap' };

export class WorkLoop {
  constructor(private readonly deps: WorkLoopDeps) {}

  async run(): Promise<WorkLoopResult> {
    throw new Error('not implemented');
  }

  // Run a single group end-to-end: worktree → Worker → (optionally) merge-pr inline.
  async runGroup(_group: PrGroup): Promise<void> {
    throw new Error('not implemented');
  }
}

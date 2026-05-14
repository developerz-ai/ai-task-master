// docs/state.md
// Only module that reads or writes .ai-task-master/. Atomic writes via temp file + fsync + rename.

import type { RunState } from './schema.ts';

export class StateStore {
  constructor(private readonly stateDir: string) {}

  // Lifecycle owners — docs/state.md §"Tree" (per-file ownership).
  // Cleanup policy — docs/state.md §"Lifecycle" (success deletes everything except logs/).

  async init(_initial: RunState): Promise<void> {
    throw new Error('not implemented');
  }

  async read(): Promise<RunState> {
    throw new Error('not implemented');
  }

  async update(_mutator: (s: RunState) => RunState): Promise<RunState> {
    throw new Error('not implemented');
  }

  async writeGoal(_goal: string, _criteria?: string): Promise<void> {
    throw new Error('not implemented');
  }

  async writePlan(_plan: string): Promise<void> {
    throw new Error('not implemented');
  }

  async appendProgress(_entry: string): Promise<void> {
    throw new Error('not implemented');
  }

  async writeContext(_summary: string): Promise<void> {
    throw new Error('not implemented');
  }

  async readContext(): Promise<string | null> {
    throw new Error('not implemented');
  }

  async cleanupOnSuccess(): Promise<void> {
    throw new Error('not implemented');
  }
}

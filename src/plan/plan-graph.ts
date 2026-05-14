// Dependency DAG over PR groups. Drives concurrent execution in src/loop/work-loop.ts.
// Why a graph and not a list — docs/task-groups.md (extended): large goals split into
// independent PRs that can run in parallel. A linear list serializes work needlessly.

import type { PrGroup } from '../state/schema.ts';

export class PlanGraph {
  // Constructed from RunState.prGroups. Validates: no cycles, no dangling deps.

  constructor(private readonly groups: ReadonlyArray<PrGroup>) {}

  // Groups currently ready to run: status === 'pending' AND all deps merged.
  ready(): PrGroup[] {
    throw new Error('not implemented');
  }

  // Groups blocked on at least one unmerged dep.
  blocked(): PrGroup[] {
    throw new Error('not implemented');
  }

  byId(_id: string): PrGroup | undefined {
    throw new Error('not implemented');
  }

  // True when every group is in a terminal state (merged or blocked).
  isComplete(): boolean {
    throw new Error('not implemented');
  }

  // Static: detect cycles + dangling deps at plan-acceptance time.
  static validate(_groups: ReadonlyArray<PrGroup>): void {
    throw new Error('not implemented');
  }
}

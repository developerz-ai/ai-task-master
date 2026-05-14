// Dependency DAG over PR groups. Drives concurrent execution in src/loop/work-loop.ts.
// Why a graph and not a list — docs/task-groups.md (extended): large goals split into
// independent PRs that can run in parallel. A linear list serializes work needlessly.

import type { PrGroup } from '../state/schema.ts';

export class PlanGraph {
  private readonly index: Map<string, PrGroup>;

  constructor(private readonly groups: ReadonlyArray<PrGroup>) {
    PlanGraph.validate(groups);
    this.index = new Map(groups.map((g) => [g.id, g]));
  }

  // Groups currently ready to run: status === 'pending' AND all deps merged.
  ready(): PrGroup[] {
    return this.groups.filter(
      (g) =>
        g.status === 'pending' &&
        g.dependsOn.every((dep) => this.index.get(dep)?.status === 'merged'),
    );
  }

  // Groups blocked on at least one unmerged dep.
  blocked(): PrGroup[] {
    return this.groups.filter(
      (g) =>
        g.status === 'pending' &&
        g.dependsOn.some((dep) => this.index.get(dep)?.status !== 'merged'),
    );
  }

  byId(id: string): PrGroup | undefined {
    return this.index.get(id);
  }

  // True when every group is in a terminal state (merged or blocked).
  isComplete(): boolean {
    return this.groups.every((g) => g.status === 'merged' || g.status === 'blocked');
  }

  // Static: detect cycles + dangling deps at plan-acceptance time.
  // DFS coloring — white=unvisited, gray=on stack, black=fully explored.
  static validate(groups: ReadonlyArray<PrGroup>): void {
    const ids = new Set(groups.map((g) => g.id));
    for (const g of groups) {
      for (const dep of g.dependsOn) {
        if (!ids.has(dep)) {
          throw new Error(`PlanGraph: group '${g.id}' depends on unknown group '${dep}'`);
        }
      }
    }

    const byId = new Map(groups.map((g) => [g.id, g]));
    const color = new Map<string, 'gray' | 'black'>();

    const visit = (id: string, path: string[]): void => {
      const state = color.get(id);
      if (state === 'black') return;
      if (state === 'gray') {
        const cycle = [...path.slice(path.indexOf(id)), id].join(' -> ');
        throw new Error(`PlanGraph: cycle detected: ${cycle}`);
      }
      color.set(id, 'gray');
      const node = byId.get(id);
      if (node) {
        for (const dep of node.dependsOn) {
          visit(dep, [...path, id]);
        }
      }
      color.set(id, 'black');
    };

    for (const g of groups) visit(g.id, []);
  }
}

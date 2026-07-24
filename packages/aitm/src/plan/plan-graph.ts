// Dependency DAG over PR groups. Drives concurrent execution in src/loop/work-loop.ts.
// Why a graph and not a list — docs/task-groups.md (extended): large goals split into
// independent PRs that can run in parallel. A linear list serializes work needlessly.

import type { PrGroup } from '../domain/pr-group.ts';

export class PlanGraph {
  private readonly index: Map<string, PrGroup>;

  private constructor(private readonly groups: ReadonlyArray<PrGroup>) {
    this.index = new Map(groups.map((g) => [g.id, g]));
  }

  // Validate the plan's structure, then build. The safe entry for untrusted groups and the gate run
  // once at plan acceptance — throws on duplicate ids, dangling deps, or cycles.
  static from(groups: ReadonlyArray<PrGroup>): PlanGraph {
    PlanGraph.validate(groups);
    return new PlanGraph(groups);
  }

  // Rebuild over an already-validated plan whose only per-tick change is group status. Skips the
  // O(V+E) validate() DFS that ready()/isComplete() would otherwise re-pay every tick. Ids and
  // dependsOn edges are fixed for a run, so one from()/validate() at acceptance covers every rebuild;
  // trusting an unvalidated cycle would make isComplete()'s memoized DFS recurse forever.
  static trusted(groups: ReadonlyArray<PrGroup>): PlanGraph {
    return new PlanGraph(groups);
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

  // True when every group is terminal: 'merged', 'blocked', or transitively blocked. A 'pending'
  // group whose dependency chain hits a dead ancestor can never satisfy ready()'s all-deps-merged
  // rule, so counting it as terminal stops the loop spinning forever on work that can't progress.
  isComplete(): boolean {
    const dead = this.deadGroupIds();
    return this.groups.every((g) => g.status === 'merged' || dead.has(g.id));
  }

  // Ids of groups that can never reach 'merged': a 'blocked' group is terminal (its PR won't land —
  // 'blocked' is the sole terminal non-merged status), and a 'pending' group with a transitively
  // dead dependency can never become ready(). Memoized DFS; callers validate the plan up front
  // (from(), or validate() at plan acceptance), so the recursion terminates and every dep resolves.
  private deadGroupIds(): Set<string> {
    const memo = new Map<string, boolean>();
    const isDead = (id: string): boolean => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      const g = this.index.get(id);
      const dead =
        g !== undefined &&
        (g.status === 'blocked' ||
          (g.status === 'pending' && g.dependsOn.some((dep) => isDead(dep))));
      memo.set(id, dead);
      return dead;
    };
    const result = new Set<string>();
    for (const g of this.groups) {
      if (isDead(g.id)) result.add(g.id);
    }
    return result;
  }

  // Static: detect cycles + dangling deps at plan-acceptance time.
  // DFS coloring — white=unvisited, gray=on stack, black=fully explored.
  static validate(groups: ReadonlyArray<PrGroup>): void {
    const ids = new Set<string>();
    for (const g of groups) {
      if (ids.has(g.id)) {
        throw new Error(`PlanGraph: duplicate group id '${g.id}'`);
      }
      ids.add(g.id);
    }
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

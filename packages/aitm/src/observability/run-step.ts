// The run's STEP + PHASE bookkeeping behind the claudetm-style `N/M` counter and phase word on
// every progress line (`[aitm 11:19:15 group 2/5 working] …`). Formatting lives in step-progress.ts
// (domain-free); the DOMAIN counting — which group/task the run is on, out of how many — lives here,
// against the real plan (PrGroup[] + prPerTask). Kept separate so step-progress stays a pure
// renderer and the counting is unit-tested against plan shapes.

import type { GroupStage, PrGroup } from '../domain/pr-group.ts';
import type { Task } from '../domain/task.ts';

// The unit-of-work counter for one progress line: `<unit> <index>/<total>`, e.g. `group 2/5` or
// `task 3/38`. Composed into a RunStep and rendered by step-progress.formatStepTag.
export type StepCounter = { unit: string; index: number; total: number };

// Resolve the counter for a group (and, in prPerTask mode, a specific task). Undefined when the
// group id is unknown to the plan — the caller then omits the counter (phase-only tag).
export type StepCounterFn = (groupId: string, task?: Task) => StepCounter | undefined;

// GroupStage → short human phase word for the harness lines. The stage machine's stages collapse to
// the operator-facing phases the user tracks (ci-failed → "ci-fix", the two review stages →
// "reviewing", ready-to-merge → "merging"). Pre-stage phases (planning, self-review, pr-open) are
// passed as literals at their call sites, not via this map.
export function phaseForStage(stage: GroupStage): string {
  switch (stage) {
    case 'pending':
    case 'working':
      return 'working';
    case 'pr-open':
      return 'pr-open';
    case 'waiting-ci':
      return 'waiting-ci';
    case 'ci-failed':
      return 'ci-fix';
    case 'waiting-reviews':
    case 'addressing-reviews':
      return 'reviewing';
    case 'ready-to-merge':
      return 'merging';
    case 'merged':
      return 'merged';
    case 'blocked':
      return 'blocked';
  }
}

// Build a counter resolver over the plan. Denominator scheme:
//   - group-mode (default): `group N/M`, M = total groups, N = the group's 1-based plan ordinal.
//   - prPerTask:           `task N/M`, M = total tasks across the plan, N = the global 1-based task
//     ordinal (tasks before the group + the task's position within it; group-level lines without a
//     specific task fall back to the group's completed-task count, so the counter still advances).
// Ordinals are fixed at plan time (group order + membership never change mid-run), so this is built
// once per run and closed over.
export function makeStepCounter(groups: readonly PrGroup[], prPerTask: boolean): StepCounterFn {
  const groupIndex = new Map<string, number>();
  const tasksBefore = new Map<string, number>();
  let acc = 0;
  groups.forEach((g, i) => {
    groupIndex.set(g.id, i);
    tasksBefore.set(g.id, acc);
    acc += g.tasks.length;
  });
  const totalGroups = groups.length;
  const totalTasks = acc;

  return (groupId, task) => {
    const gi = groupIndex.get(groupId);
    if (gi === undefined) return undefined;
    const group = groups[gi];
    if (group === undefined) return undefined;
    if (!prPerTask) {
      return { unit: 'group', index: gi + 1, total: totalGroups };
    }
    const before = tasksBefore.get(groupId) ?? 0;
    let within: number;
    if (task) {
      const idx = group.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return undefined;
      within = idx;
    } else {
      within = group.tasks.filter((t) => t.done).length;
    }
    return { unit: 'task', index: Math.min(before + within + 1, totalTasks), total: totalTasks };
  };
}

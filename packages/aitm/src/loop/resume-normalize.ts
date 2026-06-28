// Resume scheduling normalization. PlanGraph.ready() only schedules groups whose coarse status is
// 'pending', but a run interrupted mid-lifecycle persists its groups as 'in-progress' (while
// working/pr-open) or 'awaiting-pr' (while waiting on CI/reviews). On a fresh process those groups
// would never be picked up again — the loop would see zero ready groups and exit with the work half
// done. Reset such interrupted groups to 'pending' before graph construction so they re-enter the
// loop; the fine-grained `stage` and `pr` are preserved untouched, so WorkLoop.runGroup's
// resumeStage() resumes at the exact lifecycle point instead of redoing prior stages.
//
// Terminal ('merged'/'blocked') and already-schedulable ('pending') groups pass through unchanged.

import type { PrGroup, PrGroupStatus } from '../state/schema.ts';

// Coarse statuses a group can hold only because a prior run was interrupted while driving it.
const INTERRUPTED: ReadonlySet<PrGroupStatus> = new Set<PrGroupStatus>([
  'in-progress',
  'awaiting-pr',
]);

export function hasInterruptedGroup(groups: readonly PrGroup[]): boolean {
  return groups.some((g) => INTERRUPTED.has(g.status));
}

export function normalizeResumeStatus(groups: readonly PrGroup[]): PrGroup[] {
  return groups.map((g) => (INTERRUPTED.has(g.status) ? { ...g, status: 'pending' as const } : g));
}

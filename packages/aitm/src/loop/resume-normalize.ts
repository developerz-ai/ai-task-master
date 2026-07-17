// Resume scheduling normalization. PlanGraph.ready() only schedules groups whose coarse status is
// 'pending', but a run interrupted mid-lifecycle persists its groups as 'in-progress' (while
// working/pr-open) or 'awaiting-pr' (while waiting on CI/reviews). On a fresh process those groups
// would never be picked up again — the loop would see zero ready groups and exit with the work half
// done. Reset such interrupted groups to 'pending' before graph construction so they re-enter the
// loop; the fine-grained `stage` and `pr` are preserved untouched, so WorkLoop.runGroup's
// resumeStage() resumes at the exact lifecycle point instead of redoing prior stages.
//
// 'blocked' groups are ALSO reset: a block is frequently a transient provider failure (rate-limit, an
// LLM-step timeout, an overloaded endpoint), and re-running `aitm start` is a deliberate request to
// make progress on the stranded work. Without this, a single transient hiccup permanently strands a
// group across every resume. A block whose persisted `stage` is the terminal 'blocked' (the stage
// machine collapsed the real stage into it) is rewound to 'working' so it re-drives from the top;
// a block that kept a real lifecycle stage (e.g. 'pr-open') resumes there. 'merged' stays terminal.
//
// EXCEPTION: a `humanNeeded` block is NOT reset. When the CI-fix budget is exhausted (issue #128) the
// group is parked for a human, and auto-resurrecting it would re-drive an unfixable PR and burn the
// whole budget again every resume — the exact loop the durable count exists to stop. Such a group is
// left blocked so PlanGraph.ready() skips it until a human intervenes.

import type { PrGroup, PrGroupStatus } from '../state/schema.ts';

// Coarse statuses a group holds only because a prior run was interrupted or blocked while driving it.
// All are re-schedulable on an explicit resume; only 'merged' is truly terminal.
const RESUMABLE: ReadonlySet<PrGroupStatus> = new Set<PrGroupStatus>([
  'in-progress',
  'awaiting-pr',
  'blocked',
]);

// A group parked for a human (CI-fix budget exhausted) is terminal for resume purposes: it is neither
// counted as an interrupt nor auto-rescheduled, so a resume leaves it blocked instead of re-driving it.
function isHumanNeeded(group: PrGroup): boolean {
  return group.humanNeeded === true;
}

export function hasInterruptedGroup(groups: readonly PrGroup[]): boolean {
  return groups.some((g) => RESUMABLE.has(g.status) && !isHumanNeeded(g));
}

export function normalizeResumeStatus(groups: readonly PrGroup[]): PrGroup[] {
  return groups.map((g) => {
    if (!RESUMABLE.has(g.status) || isHumanNeeded(g)) return g;
    // The terminal 'blocked' stage has no handler in the stage machine — rewind it to 'working' so a
    // retried group re-drives from the top. Any real lifecycle stage is preserved for resumeStage().
    const stage = g.stage === 'blocked' ? ('working' as const) : g.stage;
    return { ...g, status: 'pending' as const, stage };
  });
}

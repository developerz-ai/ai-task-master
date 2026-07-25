// The survey loop: lead dispatches → scouts roam → lead reads the findings and closes the gaps.
//
// This is the planning-phase mirror of the work loop. There, planning decides how many workers and
// on what, the workers go do it, and a reviewer decides whether it is done. Here the lead decides how
// many scouts and where, the scouts roam the repo read-only, and the same lead decides whether the
// Planner can now plan without guessing — or aims one small follow-up wave at what is still missing.
//
// SRP: this module owns only the round structure and its termination rules. It builds no agents and
// writes no prompts — the lead (scout-lead.ts) and the scouts (planner-scouts.ts) arrive as injected
// seams, which is what lets the whole loop be tested with deterministic stubs and no provider.

import { SUBAGENT_LIMIT_DEFAULT } from '../domain/subagent-limit.ts';
import {
  FALLBACK_SCOUT_ASSIGNMENTS,
  type ScoutAssignment,
  type ScoutContext,
  type ScoutResult,
  type ScoutRunner,
  surveyRepoInParallel,
} from './planner-scouts.ts';
import type { ScoutLeadRunner } from './scout-lead.ts';

// Dispatch round plus one gap round. The second round exists to close a hole the first surfaced;
// a third would be the lead re-reading a map it already called sufficient, and planning is a phase
// the run pays for before any code is written — depth here is bought at the cost of time to first PR.
export const SCOUT_MAX_ROUNDS = 2;

export type ScoutSurveyEvent =
  // A wave is going out. `fallback` marks the lead having failed to produce one, so the fixed
  // assignments are being used — worth surfacing, since it means the wave is repo-blind.
  | { kind: 'dispatch'; round: number; assignments: readonly ScoutAssignment[]; fallback: boolean }
  | { kind: 'reported'; round: number; reported: number; dispatched: number }
  | { kind: 'complete'; rounds: number; findings: number };

export type ScoutSurveyProgress = (event: ScoutSurveyEvent) => void;

export type ScoutSurveyInit = {
  ctx: ScoutContext;
  lead: ScoutLeadRunner;
  runScout: ScoutRunner;
  maxRounds?: number;
  concurrency?: number;
  onProgress?: ScoutSurveyProgress;
};

// Drive the survey and return everything the team found, in dispatch order. Best-effort throughout:
// a dead lead falls back to the fixed assignments, a dead scout drops its own finding, and a failed
// wave returns what the other rounds gathered — the survey is an accelerator for the Planner, never
// a gate in front of it, so nothing in here may propagate a failure up to the run.
export async function runScoutSurvey(init: ScoutSurveyInit): Promise<ScoutResult[]> {
  const { ctx, lead, runScout, onProgress } = init;
  const maxRounds = init.maxRounds ?? SCOUT_MAX_ROUNDS;
  const concurrency = init.concurrency ?? SUBAGENT_LIMIT_DEFAULT;
  const results: ScoutResult[] = [];
  // Keys already dispatched, across ALL rounds: the gap round is told not to re-send a scout over
  // covered ground, and this is what holds when it does it anyway.
  const dispatched = new Set<string>();
  let round = 0;
  while (round < maxRounds) {
    round += 1;
    const proposed = await lead(ctx, results).catch(() => []);
    // An empty FIRST wave is a dead or unusable lead — the fixed assignments keep the survey running
    // rather than handing the Planner nothing. An empty LATER wave is the lead saying it is done.
    const fallback = round === 1 && proposed.length === 0;
    const wave = (fallback ? FALLBACK_SCOUT_ASSIGNMENTS : proposed).filter(
      (assignment) => !dispatched.has(assignment.key),
    );
    if (wave.length === 0) break;
    for (const assignment of wave) dispatched.add(assignment.key);
    onProgress?.({ kind: 'dispatch', round, assignments: wave, fallback });
    const reported = await surveyRepoInParallel(wave, ctx, runScout, concurrency).catch(() => []);
    onProgress?.({ kind: 'reported', round, reported: reported.length, dispatched: wave.length });
    results.push(...reported);
    // Nothing came back at all: the gap round would be reading an empty report and re-deciding from
    // the same map, so it can only repeat the wave that just died.
    if (results.length === 0) break;
  }
  onProgress?.({ kind: 'complete', rounds: round, findings: results.length });
  return results;
}

// The scout lead: decides HOW MANY scouts the survey sends and WHERE they look.
//
// The fixed lens set this replaces was repo-blind — the same four questions whether the repo was a
// twelve-package monorepo or a single `src/`, and blind to what the goal actually touches. The lead
// is the planning-side analogue of what the loop already does for work: take a sneak peek at the
// codebase, then decide the shape of the wave. It runs twice per survey — once to dispatch, once to
// read the findings and either declare the map good enough or aim a small follow-up at the gaps.
//
// SRP: this module owns the lead agent and its two prompts. The scouts it dispatches live in
// planner-scouts.ts; the rounds that alternate between them in scout-survey.ts.

import { createSubagent, runWithSchemaRetry } from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { z } from 'zod';
import { AGENT_STEP_BACKSTOP, forwardInit } from './factory.ts';
import type { PlannerTools } from './planner.ts';
import {
  SCOUT_MAX_ASSIGNMENTS,
  type ScoutAgentInit,
  type ScoutAssignment,
  ScoutAssignmentSchema,
  type ScoutContext,
  type ScoutResult,
  synthesizeSurveyBrief,
} from './planner-scouts.ts';

// Same runaway backstop as every other subagent — the lead terminates by submitting, not by running
// out of steps (see AGENT_STEP_BACKSTOP).
export const SCOUT_LEAD_MAX_STEPS = AGENT_STEP_BACKSTOP;

// What the lead submits: the wave to dispatch, or an empty list meaning "no scouting needed / the
// team is done". One schema for both rounds — the round is carried by the prompt, not the shape.
export const ScoutPlanSchema = z.object({
  assignments: z.array(ScoutAssignmentSchema).max(SCOUT_MAX_ASSIGNMENTS).default([]),
  // Why this wave, in one line. Not consumed by the Planner — it is what makes a survey's dispatch
  // decision readable in the logs when a run plans something surprising.
  rationale: z.string().default(''),
});
export type ScoutPlan = z.infer<typeof ScoutPlanSchema>;

export const SCOUT_LEAD_SYSTEM_PREFIX = [
  'You are the scout lead for the planning phase. You do NOT plan the work and you do NOT survey the',
  'repo yourself — you decide what a Planner must learn about this codebase before it can plan, and',
  'you dispatch a parallel team of read-only scouts to find it out.',
  '',
  'You have the read-only tools (glob/grep/readFile, and `explore` when present). Use them for a quick',
  'peek — enough to see how this repo is actually organized and which parts the goal touches — not for',
  'the survey itself. That is what the scouts are for; every question you answer yourself is one your',
  'team could have answered in parallel while you were deciding.',
  '',
  'Then call submit with the wave.',
].join('\n');

// Everything the lead needs to build its agent. Identical dial set to a scout's — same model, same
// read-only tools, same run-scoped signal — so the two are wired from one place in the adapter.
export type ScoutLeadInit = ScoutAgentInit;

// Decides one wave. `prior` is empty on the dispatch round and holds the findings so far on the gap
// round. Returns [] when the lead wants no (further) scouting — or when its call failed, which the
// caller distinguishes by round: an empty FIRST wave is a dead lead and falls back to the fixed
// assignments, an empty follow-up is the lead saying the map is complete.
export type ScoutLeadRunner = (
  ctx: ScoutContext,
  prior: readonly ScoutResult[],
) => Promise<ScoutAssignment[]>;

export function createScoutLeadRunner(init: ScoutLeadInit): ScoutLeadRunner {
  return async (ctx, prior) => {
    const agent = createSubagent<PlannerTools>(
      {
        model: init.model,
        tools: init.tools,
        systemPrompt: init.systemPrompt,
        submit: tool({
          description: 'Submit the scout wave to dispatch (the ScoutPlan schema).',
          inputSchema: ScoutPlanSchema,
          execute: async (plan: ScoutPlan) => plan,
        }),
        ...forwardInit(init),
      },
      SCOUT_LEAD_MAX_STEPS,
    );
    const prompt = prior.length === 0 ? buildLeadPrompt(ctx) : buildGapPrompt(ctx, prior);
    const submitted = await runWithSchemaRetry(
      agent,
      ScoutPlanSchema,
      prompt,
      init.onUsage ? { onUsage: init.onUsage } : {},
    );
    return submitted.ok ? dedupeByKey(submitted.value.assignments) : [];
  };
}

// The dispatch round. The map does the orienting, so the prompt spends its words on the one decision
// the lead owns: how many scouts this repo warrants and what territory each gets.
export function buildLeadPrompt(ctx: ScoutContext): string {
  return [
    `Goal for the upcoming plan: ${ctx.goal}`,
    ...(ctx.criteria?.trim() ? [`Acceptance criteria: ${ctx.criteria}`] : []),
    ...(ctx.repoMap?.trim() ? ['', ctx.repoMap] : []),
    '',
    `Dispatch the survey wave: up to ${SCOUT_MAX_ASSIGNMENTS} scouts, as many as this repo genuinely`,
    'needs and no more. Size it to the work, not to a habit.',
    '',
    'One scout covers a LOT of ground — it reads as many files as it judges necessary and is not',
    'rationed. So splitting is only worth it when the ground genuinely divides: separate areas that',
    'can be surveyed without knowing each other. A small or focused codebase, or a goal that touches',
    'one part of a big one, is ONE scout — that is a good answer, not a lazy one. Two scouts on the',
    'same ground return the same facts twice and cost the Planner a longer brief to read. A large',
    'monorepo where the goal spans packages is where a real team pays off: one scout per area.',
    '',
    'Judge every assignment by its size before you send it:',
    '  - TOO BIG if answering it means crossing unrelated areas of the codebase, or if a scout would',
    '    have to settle things that do not inform each other. Split it along that seam.',
    '  - TOO SMALL if it lands in the same files as another assignment, or if it is one question a',
    '    neighbouring scout answers on its way through. Merge it.',
    'Keep splitting or merging until each scout has one coherent area it can own end to end.',
    '',
    'Each assignment is ONE self-contained question a single scout can answer alone. The scout shares',
    'NONE of your context, so anything you leave out is lost to it.',
    '',
    'Brief each scout properly — a question alone wastes it. Give it:',
    '  - subQuestions: the specific things that must be settled for the answer to be usable',
    '  - startPaths: the directories from the map where its territory begins',
    '  - mustRead: files that decide the answer and must be read whole, not grepped',
    '  - searchTerms: what this thing is actually CALLED in this codebase — the identifiers, types and',
    '    config keys a scout would otherwise have to guess at',
    '',
    'Everything you hand over is a starting point, never a limit: the scout reads as much as it judges',
    'necessary, corrects you where the map misled you, and follows the code past whatever you named.',
    'You are aiming it, not scripting it — a well-aimed scout with room to move outruns a scripted one.',
    '',
    'Aim at what would otherwise make the Planner guess: how this codebase is built and tested, the',
    'patterns a new feature must match, and the seams the goal has to hook into. Then call submit.',
  ].join('\n');
}

// The gap round. Deliberately biased toward stopping: the follow-up must earn itself by naming a
// hole, because a lead that re-dispatches on general unease buys a whole extra wave of provider
// calls for ground the team already covered.
export function buildGapPrompt(ctx: ScoutContext, prior: readonly ScoutResult[]): string {
  return [
    `Goal for the upcoming plan: ${ctx.goal}`,
    ...(ctx.criteria?.trim() ? [`Acceptance criteria: ${ctx.criteria}`] : []),
    '',
    'Your team reported back:',
    '',
    synthesizeSurveyBrief(prior),
    '',
    'Read what came back. If the Planner can now plan this goal without guessing, submit an EMPTY',
    'assignments list — that is the expected outcome and it costs nothing to say so.',
    '',
    `Otherwise dispatch a SMALL follow-up wave (at most ${SCOUT_MAX_ASSIGNMENTS}) aimed ONLY at`,
    'specific gaps: an open question the team raised, a contradiction between two findings, or an area',
    'the goal clearly touches that nobody looked at. Never re-send a scout over ground already',
    'covered, and never send one to "double-check" a finding you have no reason to doubt.',
  ].join('\n');
}

// Two assignments sharing a key would collide as brief headings and read as one section. First wins.
function dedupeByKey(assignments: readonly ScoutAssignment[]): ScoutAssignment[] {
  const seen = new Set<string>();
  const kept: ScoutAssignment[] = [];
  for (const assignment of assignments) {
    const key = assignment.key.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...assignment, key });
  }
  return kept;
}

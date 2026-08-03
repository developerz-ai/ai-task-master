// Does the goal still have work left, given what already landed?
//
// The run loop drives a plan to exhaustion and stops. Nothing ever asks whether the GOAL was met, so
// a plan that under-covers it ships a fraction and reports success. This agent is that question,
// asked after a wave of PR groups lands: it reads the repo as it now is and answers "done" or "here
// is what remains", which the Planner then plans as the next wave.
//
// SRP: this module owns the assessment agent and its prompt. Planning from `remaining` is the
// Planner's job (planner.ts); looping the waves is the adapter's (run-loop-adapter.ts).

import { createSubagent, runWithSchemaRetry } from '@developerz.ai/ai-claude-compat';
import { type ToolLoopAgent, tool } from 'ai';
import { z } from 'zod';
import { AGENT_STEP_BACKSTOP, forwardInit, type SubagentInit } from './factory.ts';
import type { PlannerTools } from './planner.ts';

// Same runaway backstop as every other subagent — it terminates by submitting, not by running out.
export const GOAL_ASSESSOR_MAX_STEPS = AGENT_STEP_BACKSTOP;

export const GoalAssessmentSchema = z.object({
  complete: z.boolean(),
  // Not complete → the work still owed, phrased as a goal a Planner can plan from. Ignored (and
  // normally empty) when complete. A blank `remaining` on an incomplete verdict ends the run anyway:
  // there is nothing to plan from, and inventing work is how a loop never terminates.
  remaining: z.string().default(''),
  // One line of why, for the operator reading progress output. Never consumed by the Planner.
  rationale: z.string().default(''),
});
export type GoalAssessment = z.infer<typeof GoalAssessmentSchema>;

export type GoalAssessorAgent = ToolLoopAgent<never, PlannerTools>;

// The assessor reads the repo but never writes it, so it takes the Planner's read-only tool surface.
export type GoalAssessorInput = {
  goal: string;
  criteria?: string;
  // What the run has shipped so far, one line per landed group. The assessor checks the REPO, not
  // this list — the list only tells it what to expect so a missing capability reads as a gap rather
  // than as something it simply hasn't found yet.
  delivered: readonly string[];
  contextBlock?: string;
};

export { GOAL_ASSESSOR_SYSTEM_PREFIX } from './prompts/role-guidance.ts';

const assessorInitRegistry = new WeakMap<GoalAssessorAgent, SubagentInit<PlannerTools>>();

export function createGoalAssessorAgent(init: SubagentInit<PlannerTools>): GoalAssessorAgent {
  const agent = createSubagent<PlannerTools>(
    {
      model: init.model,
      tools: init.tools,
      systemPrompt: init.systemPrompt,
      submit: tool({
        description: 'Submit the verdict: is the goal delivered, and if not, what remains.',
        inputSchema: GoalAssessmentSchema,
        execute: async (assessment) => assessment,
      }),
      ...forwardInit<PlannerTools>(init),
    },
    GOAL_ASSESSOR_MAX_STEPS,
  );
  assessorInitRegistry.set(agent, init);
  return agent;
}

// A failed assessment reports COMPLETE. The alternative — treating "the assessor broke" as "there is
// more work" — plans another wave off no evidence, which spends the user's money on a guess. Doing
// less is the safe direction when the check itself is what failed.
export async function runGoalAssessor(
  agent: GoalAssessorAgent,
  input: GoalAssessorInput,
): Promise<GoalAssessment> {
  const onUsage = assessorInitRegistry.get(agent)?.onUsage;
  try {
    const submitted = await runWithSchemaRetry(
      agent,
      GoalAssessmentSchema,
      buildAssessorPrompt(input),
      { ...(onUsage ? { onUsage } : {}) },
    );
    if (!submitted.ok) {
      return { complete: true, remaining: '', rationale: 'assessor did not submit a verdict' };
    }
    const value = submitted.value;
    // An incomplete verdict with nothing to plan from is a completion: the next step would be to
    // call the Planner with an empty goal.
    if (!value.complete && value.remaining.trim() === '') {
      return { ...value, complete: true, rationale: 'no remaining work named' };
    }
    return value;
  } catch {
    return { complete: true, remaining: '', rationale: 'assessor failed' };
  }
}

function buildAssessorPrompt(input: GoalAssessorInput): string {
  const lines = [`Goal: ${input.goal}`];
  if (input.criteria?.trim()) lines.push(`Acceptance criteria: ${input.criteria}`);
  lines.push('', 'Already delivered by this run:');
  lines.push(
    ...(input.delivered.length > 0
      ? input.delivered.map((d) => `- ${d}`)
      : ['- (nothing yet — no group has landed)']),
  );
  lines.push('', 'Check the repo against the goal with the read-only tools, then call submit.');
  const body = lines.join('\n');
  return input.contextBlock ? `${input.contextBlock}\n\n${body}` : body;
}

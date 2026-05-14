// docs/subagents.md (Planner row), docs/task-groups.md, docs/agent-config-detection.md
// Goal + repo survey → ordered PR groups (DAG) with Zod-validated output.
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Subagents" + chunk-05.md §"Generating Structured Data".

import { type DeepPartial, Output, stepCountIs, ToolLoopAgent, type ToolSet } from 'ai';
import { type Plan, type PlannedGroup, type PlannedTask, PlanSchema } from '../plan/schema.ts';
import type { SubagentInit } from './factory.ts';

type PlannerOutput = Output.Output<Plan, DeepPartial<Plan>, never>;

export type PlannerAgent = ToolLoopAgent<never, PlannerTools, PlannerOutput>;

export type PlannerTools = ToolSet;

export type PlannerInput = {
  goal: string;
  criteria?: string;
  styleContents: string;
  maxPrs: number;
};

export type PlannerResult =
  | { kind: 'ok'; plan: Plan }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

// Inlined per CLAUDE.md "no premature abstraction". The Orchestrator builds the
// caller-side system prompt as `styleContents + PLANNER_SYSTEM_PREFIX` so the
// agent inherits the repo's house style alongside its role.
export const PLANNER_SYSTEM_PREFIX = [
  '',
  'You are the Planner subagent. You receive a goal and an optional acceptance criteria.',
  'You output a directed-acyclic plan of PR groups: each group is one cohesive pull request,',
  'roughly 300 lines of code, that can be reviewed independently. Use read-only repo tools',
  '(readFile, glob, grep) to ground the plan in the actual code before emitting it.',
  '',
  'Rules:',
  '- Emit at most maxPrs groups. If the work is larger, fold the tail into the last group.',
  '- Each group has a stable id (slug), a one-line title, an ordered list of tasks,',
  '  and a dependsOn list of earlier group ids. dependsOn is empty for the root(s).',
  '- Prefer parallelizable siblings over a single linear chain.',
  '- Do not invent files. Do not propose work outside the repo.',
  '',
  'Return JSON that matches the Plan schema exactly.',
].join('\n');

export function createPlannerAgent(init: SubagentInit<PlannerTools>): PlannerAgent {
  return new ToolLoopAgent<never, PlannerTools, PlannerOutput>({
    model: init.model,
    tools: init.tools,
    instructions: init.systemPrompt,
    output: plannerOutput(),
    stopWhen: stepCountIs(init.maxSteps ?? 20),
  });
}

export async function runPlanner(agent: PlannerAgent, input: PlannerInput): Promise<PlannerResult> {
  if (!Number.isInteger(input.maxPrs) || input.maxPrs < 1) {
    return { kind: 'error', error: `maxPrs must be a positive integer, received ${input.maxPrs}` };
  }
  try {
    const result = await agent.generate({ prompt: buildUserPrompt(input) });
    const raw = result.experimental_output;
    if (!raw.groups || raw.groups.length === 0) {
      return { kind: 'blocked', reason: 'planner returned an empty group list' };
    }
    return { kind: 'ok', plan: capGroups(raw, input.maxPrs) };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function plannerOutput(): PlannerOutput {
  return Output.object({ schema: PlanSchema, name: 'Plan' });
}

function buildUserPrompt(input: PlannerInput): string {
  const lines = [`Goal: ${input.goal}`];
  if (input.criteria?.trim()) {
    lines.push(`Acceptance criteria: ${input.criteria}`);
  }
  lines.push(`maxPrs: ${input.maxPrs}`);
  lines.push('Survey the repo with the read-only tools, then emit the Plan JSON.');
  return lines.join('\n');
}

// Truncate to maxPrs groups; fold any overflow into a single remainder task on
// the last kept group so no work is silently dropped.
function capGroups(plan: Plan, maxPrs: number): Plan {
  if (plan.groups.length <= maxPrs) return plan;
  const kept = plan.groups.slice(0, maxPrs);
  const overflow = plan.groups.slice(maxPrs);
  const lastKept = kept[maxPrs - 1];
  if (!lastKept) return plan;
  const remainder: PlannedTask = {
    description: `remainder: ${overflow.map(summarizeGroup).join('; ')}`,
  };
  const merged: PlannedGroup = { ...lastKept, tasks: [...lastKept.tasks, remainder] };
  const newGroups = [...kept.slice(0, maxPrs - 1), merged];
  return { ...plan, groups: newGroups };
}

function summarizeGroup(g: PlannedGroup): string {
  return `${g.id} (${g.tasks.length} tasks)`;
}

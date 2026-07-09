// docs/subagents.md (Planner row), docs/task-groups.md, docs/agent-config-detection.md
// Goal + repo survey → ordered PR groups (DAG) with Zod-validated output.
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Subagents" + chunk-05.md §"Generating Structured Data".

import type {
  GlobInput,
  GlobOutput,
  GrepInput,
  GrepOutput,
  ReadFileInput,
  ReadFileOutput,
} from '@developerz.ai/ai-claude-compat';
import {
  createSubagent,
  formatSubmitIssues,
  runWithSchemaRetry,
} from '@developerz.ai/ai-claude-compat';
import { type Tool, type ToolLoopAgent, tool } from 'ai';
import { type Plan, type PlannedGroup, type PlannedTask, PlanSchema } from '../plan/schema.ts';
import type { SubagentInit } from './factory.ts';

export type PlannerAgent = ToolLoopAgent<never, PlannerTools>;

// The Planner only surveys the repo — it gets the read-only subset of the Claude-Code-style
// tool surface (no write/edit/bash).
export type PlannerTools = {
  readFile: Tool<ReadFileInput, ReadFileOutput>;
  grep: Tool<GrepInput, GrepOutput>;
  glob: Tool<GlobInput, GlobOutput>;
};

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
  'You are the Planner. Goal (+ optional acceptance criteria) → a DAG of PR groups. Ground it in the',
  'real code first with the read-only tools (glob/grep/readFile); do not invent files.',
  '',
  'Each group = one cohesive pull request: ≤~300 LOC, independently reviewable — a reviewer needs no',
  'other group open to judge it. If a group only makes sense alongside another, merge them.',
  '',
  'Tips:',
  '- Emit ≤ maxPrs groups. More work than that → fold the tail into the last group.',
  '- dependsOn = only the earlier groups whose code this one builds on; empty for roots. Wrong deps',
  '  serialize work that could have run in parallel.',
  '- Prefer parallel siblings over one linear chain.',
].join('\n');

export function createPlannerAgent(init: SubagentInit<PlannerTools>): PlannerAgent {
  return createSubagent<PlannerTools>(
    {
      model: init.model,
      tools: init.tools,
      systemPrompt: init.systemPrompt,
      submit: tool({
        description: 'Submit the finished plan as an ordered list of PR groups (the Plan schema).',
        inputSchema: PlanSchema,
        execute: async (plan) => plan,
      }),
      ...(init.maxSteps !== undefined ? { maxSteps: init.maxSteps } : {}),
    },
    20,
  );
}

export async function runPlanner(agent: PlannerAgent, input: PlannerInput): Promise<PlannerResult> {
  if (!Number.isInteger(input.maxPrs) || input.maxPrs < 1) {
    return { kind: 'error', error: `maxPrs must be a positive integer, received ${input.maxPrs}` };
  }
  try {
    const submitted = await runWithSchemaRetry(agent, PlanSchema, buildUserPrompt(input));
    if (!submitted.ok) {
      // Only after the retry kernel exhausts. Distinguish the two failure modes in the message so
      // a weak model that never submits reads differently from one that keeps mangling the schema.
      if (submitted.reason === 'invalid') {
        return {
          kind: 'error',
          error: `planner plan failed schema validation after retries: ${formatSubmitIssues(submitted.issues)}`,
        };
      }
      return { kind: 'blocked', reason: 'planner did not submit a plan after retries' };
    }
    if (submitted.value.groups.length === 0) {
      return { kind: 'blocked', reason: 'planner returned an empty group list' };
    }
    return { kind: 'ok', plan: capGroups(submitted.value, input.maxPrs) };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function buildUserPrompt(input: PlannerInput): string {
  const lines = [`Goal: ${input.goal}`];
  if (input.criteria?.trim()) {
    lines.push(`Acceptance criteria: ${input.criteria}`);
  }
  lines.push(`maxPrs: ${input.maxPrs}`);
  lines.push('Survey the repo with the read-only tools, then call submit with the Plan.');
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
    complexity: 'normal',
  };
  const merged: PlannedGroup = { ...lastKept, tasks: [...lastKept.tasks, remainder] };
  const newGroups = [...kept.slice(0, maxPrs - 1), merged];
  return { ...plan, groups: newGroups };
}

function summarizeGroup(g: PlannedGroup): string {
  return `${g.id} (${g.tasks.length} tasks)`;
}

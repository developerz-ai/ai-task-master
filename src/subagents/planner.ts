// docs/subagents.md (Planner row), docs/task-groups.md, docs/agent-config-detection.md
// Goal + repo survey → ordered PR groups (DAG) with Zod-validated output.
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Subagents" + chunk-05.md §"Generating Structured Data".

import type { ToolLoopAgent } from 'ai';
import type { Plan } from '../plan/schema.ts';
import type { SubagentInit } from './factory.ts';

export type PlannerTools = {
  readFile: unknown;
  glob: unknown;
  grep: unknown;
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

// Build the agent: model = capability "smart". System prompt = style payload + planner-system prefix.
// Output schema = src/plan/schema.ts §PlanSchema, enforced via Output.object().
export function createPlannerAgent(_init: SubagentInit): ToolLoopAgent<PlannerTools> {
  throw new Error('not implemented');
}

export async function runPlanner(
  _agent: ToolLoopAgent<PlannerTools>,
  _input: PlannerInput,
): Promise<PlannerResult> {
  throw new Error('not implemented');
}

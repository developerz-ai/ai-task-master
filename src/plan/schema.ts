// Plan-time output of Planner subagent — see docs/subagents.md §Roster (Planner row).
// PrGroup is persisted via src/state/schema.ts; the plan schema below is what
// Planner returns to the Orchestrator before that persistence step.

import { z } from 'zod';

export const PlannedTaskSchema = z.object({
  description: z.string(),
  // Optional file hint helps Worker plan its parallel file-edit fanout.
  // See docs/vendor/ai-sdk/chunk-09.md §"Orchestrator-Worker" — Worker uses this
  // to emit a file manifest, then Promise.all over per-file editor subagents.
  filesHint: z.array(z.string()).optional(),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

export const PlannedGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  tasks: z.array(PlannedTaskSchema),
  // Group ids that must merge before this group runs. Empty = root of DAG.
  dependsOn: z.array(z.string()).default([]),
});
export type PlannedGroup = z.infer<typeof PlannedGroupSchema>;

export const PlanSchema = z.object({
  goal: z.string(),
  criteria: z.string().optional(),
  groups: z.array(PlannedGroupSchema),
});
export type Plan = z.infer<typeof PlanSchema>;

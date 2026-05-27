// docs/state.md §"state.json schema" and §"PrGroup sub-schema"
// Source of truth for run-state shape. Extended with PrGroup.dependsOn to support DAG planning.

import { z } from 'zod';

export const PrGroupStatusSchema = z.enum([
  'pending',
  'in-progress',
  'awaiting-pr',
  'merged',
  'blocked',
]);
export type PrGroupStatus = z.infer<typeof PrGroupStatusSchema>;

export const PrGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  tasks: z.array(z.string()),
  // Group ids that must be merged before this group is runnable.
  // Empty array means the group is in the initial ready set. See src/plan/plan-graph.ts.
  dependsOn: z.array(z.string()).default([]),
  branch: z.string().nullable(),
  pr: z.number().int().positive().nullable(),
  status: PrGroupStatusSchema,
});
export type PrGroup = z.infer<typeof PrGroupSchema>;

export const RunStatusSchema = z.enum([
  'planning',
  'working',
  'awaiting-pr',
  'reviewing',
  'blocked',
  'success',
  'failed',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStateSchema = z.object({
  status: RunStatusSchema,
  prGroups: z.array(PrGroupSchema),
  currentGroupIndex: z.number().int().nonnegative(),
  currentTaskIndex: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  currentPr: z.number().int().positive().nullable(),
  runId: z.string(),
  provider: z.literal('openrouter'),
  model: z.string(),
  agentConfigFile: z.enum(['CLAUDE.md', 'AGENTS.md', 'custom']),
  createdAt: z.string(),
  updatedAt: z.string(),
  options: z.object({
    autoMerge: z.boolean(),
    maxPrs: z.number().int().positive(),
    maxSessions: z.number().int().positive().nullable(),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']),
    stylePath: z.string().nullable(),
    concurrency: z.number().int().positive(),
  }),
});
export type RunState = z.infer<typeof RunStateSchema>;

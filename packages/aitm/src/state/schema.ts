// docs/state.md §"state.json schema" and §"PrGroup sub-schema"
// Source of truth for run-state shape. Extended with PrGroup.dependsOn to support DAG planning
// and PrGroup.tasks as structured Task[] (complexity + per-task completion) for task-by-task execution.

import { z } from 'zod';

export const TaskComplexitySchema = z.enum(['simple', 'normal', 'complex']);
export type TaskComplexity = z.infer<typeof TaskComplexitySchema>;

export const TaskSchema = z.object({
  id: z.string(),
  text: z.string(),
  complexity: TaskComplexitySchema,
  done: z.boolean(),
  subtasks: z.array(z.string()).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const PrGroupStatusSchema = z.enum([
  'pending',
  'in-progress',
  'awaiting-pr',
  'merged',
  'blocked',
]);
export type PrGroupStatus = z.infer<typeof PrGroupStatusSchema>;

// Per-group persisted position in the PR lifecycle so a crashed/paused run resumes mid-PR
// without redoing prior stages. Per-group (not global) because aitm runs groups concurrently.
// Drives WorkLoop.runGroup's stage dispatcher (slice 03). See docs/plans .../03-pr-lifecycle-stages.md.
export const GroupStageSchema = z.enum([
  'pending',
  'working',
  'pr-open',
  'waiting-ci',
  'ci-failed',
  'waiting-reviews',
  'addressing-reviews',
  'ready-to-merge',
  'merged',
  'blocked',
]);
export type GroupStage = z.infer<typeof GroupStageSchema>;

export const PrGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  tasks: z.array(TaskSchema),
  // Group ids that must be merged before this group is runnable.
  // Empty array means the group is in the initial ready set. See src/plan/plan-graph.ts.
  dependsOn: z.array(z.string()).default([]),
  branch: z.string().nullable(),
  pr: z.number().int().positive().nullable(),
  status: PrGroupStatusSchema,
  stage: GroupStageSchema.default('pending'),
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
    prPerTask: z.boolean().default(false),
    maxPrs: z.number().int().positive(),
    maxSessions: z.number().int().positive().nullable(),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']),
    stylePath: z.string().nullable(),
    concurrency: z.number().int().positive(),
  }),
});
export type RunState = z.infer<typeof RunStateSchema>;

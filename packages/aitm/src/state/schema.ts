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
  // The Planner's acceptance check for this group (PlannedGroup.acceptance): the command or
  // observable that proves it done. Persisted so a resumed run judges the group against the same
  // contract the original plan set, and so a human reading state.json sees what "done" meant.
  // Optional — legacy state (and groups built off-schema in tests) load without it; consumers treat
  // a missing check as "no check to hold this group to". See src/plan/acceptance.ts.
  acceptance: z.string().optional(),
  // Group ids that must be merged before this group is runnable.
  // Empty array means the group is in the initial ready set. See src/plan/plan-graph.ts.
  dependsOn: z.array(z.string()).default([]),
  branch: z.string().nullable(),
  pr: z.number().int().positive().nullable(),
  // The PR's web URL, persisted alongside its number so every later report — the end-of-run summary,
  // a blocked run, a resume — can link straight to it instead of printing a bare number the reader
  // has to go look up. Optional: legacy state (and groups built off-schema in tests) load without it.
  prUrl: z.string().url().optional(),
  status: PrGroupStatusSchema,
  stage: GroupStageSchema.default('pending'),
  // Durable count of CI-fix passes dispatched for this group's PR, persisted so the recovery budget
  // survives a resume: a crash-resumed group re-seeds its in-memory counter from this instead of
  // restarting at zero and cycling forever on an unfixable red PR. Optional — legacy state (and
  // in-memory groups built off-schema) load as 0. See issue #128.
  ciFixAttempts: z.number().int().nonnegative().optional(),
  // Set once the CI-fix budget is exhausted: the group is blocked for a human and must NOT be
  // auto-rescheduled on resume (normalizeResumeStatus skips it) — unlike a transient provider block,
  // which a resume retries. Optional — legacy state loads as not-human-needed. See issue #128.
  humanNeeded: z.boolean().optional(),
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

// Per-run token/cost accounting persisted at flush (issue #114). Additive + optional so a legacy
// state.json without it still parses. Mirrors UsageTracker.totals(): tokens per role + overall, with
// costUsd null when any pricing was unknown. cacheWriteInputTokens/cacheDiscountUsd (slice 04b)
// default so a pre-slice-04b state.json still parses.
const RoleUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative().default(0),
  calls: z.number().int().nonnegative(),
  costUsd: z.number().nullable(),
  cacheDiscountUsd: z.number().nullable().default(null),
});
export const UsageTotalsSchema = z.object({
  // partialRecord (not record): only roles that actually ran are present, matching UsageTracker.totals.
  perRole: z.partialRecord(
    z.enum(['planner', 'worker', 'reviewer', 'orchestrator']),
    RoleUsageSchema,
  ),
  overall: RoleUsageSchema,
});

// Bumped whenever the persisted shape changes in a way a schema default cannot absorb; each bump
// gets a step in state/migrations.ts keyed by the version it reads. v1 is the first versioned shape:
// structured PrGroup.tasks and PrGroup.stage, neither of which v0 (unversioned) state.json carried.
export const CURRENT_SCHEMA_VERSION = 1;

export const RunStateSchema = z.object({
  // Stamped on every write, checked on every read: state from a newer aitm is refused, not coerced.
  // A file with no version at all is v0 — migrations.ts lifts it before this schema sees it.
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
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
  // Token/cost totals, written after the loop returns (issue #114). Optional so old state files load.
  usage: UsageTotalsSchema.optional(),
});
export type RunState = z.infer<typeof RunStateSchema>;

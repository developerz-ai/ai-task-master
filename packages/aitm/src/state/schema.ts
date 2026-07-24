// docs/state.md §"state.json schema". Source of truth for the persisted run-state shape.
// The work-unit types it embeds — Task, PrGroup and their lifecycle enums — live in src/domain/
// (imported below) so plan/, subagents/ and state/ share them without a dir-level cycle.

import { z } from 'zod';
import { PrGroupSchema } from '../domain/pr-group.ts';

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

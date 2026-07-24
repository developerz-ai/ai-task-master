// A PR-sized group of tasks and its position in the PR lifecycle. Shared leaf type: plan builds
// groups, state persists them, and the loop/subagents drive them — so the shape lives here, below all
// of them, to keep those dirs acyclic. See docs/state.md §"PrGroup sub-schema".

import { z } from 'zod';
import { TaskSchema } from './task.ts';

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
  // Set once the review-comments grace sleep has been applied after CI passes. Prevents re-sleeping on
  // every waiting-ci pass when the loop revisits this stage (e.g. after addressing reviews and
  // re-polling CI). Optional — legacy state loads as false (grace will re-fire, a safe degradation). Task #46.
  reviewGraceApplied: z.boolean().default(false),
});
export type PrGroup = z.infer<typeof PrGroupSchema>;

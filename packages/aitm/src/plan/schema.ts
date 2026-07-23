// Plan-time output of Planner subagent — see docs/subagents.md §Roster (Planner row).
// PrGroup is persisted via src/state/schema.ts; the plan schema below is what
// Planner returns to the Orchestrator before that persistence step.

import { z } from 'zod';
import { TaskComplexitySchema } from '../state/schema.ts';

// The `.describe()` text reaches the model as the tool-input JSON schema, at the moment it fills the
// field — far closer to the decision than the system prompt, and the only layer the schema-retry
// loop can enforce. Kept one line each and consistent with PLANNER_SYSTEM_PREFIX.
export const PlannedTaskSchema = z.object({
  description: z
    .string()
    .describe(
      'Verb-first, checkable, and a whole slice of behaviour WITH its tests — normally several files, ~100-400 lines. Never one task per file, never a verification step: "Add todo CRUD repository, services, and routes with unit tests".',
    ),
  // Mirrors Task.complexity in src/state/schema.ts — kept in sync so Planner
  // output maps onto persisted PrGroup.tasks without a separate field.
  complexity: TaskComplexitySchema.default('normal'),
  // Optional file hint helps Worker plan its parallel file-edit fanout.
  // See docs/vendor/ai-sdk/chunk-09.md §"Orchestrator-Worker" — Worker uses this
  // to emit a file manifest, then Promise.all over per-file editor subagents.
  filesHint: z.array(z.string()).optional(),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

// A title over this reads as a sentence, not a label — and it becomes a branch name and a PR
// subject, both of which truncate. Failing validation here routes to the schema-retry loop, which is
// cheaper than a run full of `aitm/g2-implement-the-crud-endpoints-for` branches.
const MAX_TITLE_CHARS = 48;

// A group with no tasks is a PR with nothing in it, and past ~5 tasks the group was almost certainly
// split by file rather than by behaviour — the exact shape that makes every task pay a full repo
// survey to write ~40 lines. Both bounds are cheap to enforce: a violation is a Zod issue the
// schema-retry loop re-asks with, one extra Planner turn against a whole run of undersized PRs.
// The cap applies to what Planner SUBMITS; capGroups may later fold an overflow remainder task onto
// the last kept group, which is constructed in TypeScript and never re-parsed.
const MAX_TASKS_PER_GROUP = 5;

export const PlannedGroupSchema = z.object({
  id: z.string(),
  title: z
    .string()
    .min(1)
    .max(MAX_TITLE_CHARS)
    .describe(
      'Branch name + PR subject: 2-5 word noun phrase naming the capability delivered, no trailing period, no "feat:" prefix. E.g. "Todo CRUD API".',
    ),
  tasks: z
    .array(PlannedTaskSchema)
    .min(1)
    .max(MAX_TASKS_PER_GROUP)
    .describe(
      'The 1-5 disjoint behaviour slices this PR is built from. No two may cover the same work, and none may be a verification step. Too many? MERGE them into bigger slices — never drop work, and never split a slice per file.',
    ),
  // REQUIRED, not optional: this is the only thing that separates "the model says it is done" from
  // "something demonstrated it", and it is what the Worker builds against and the pre-PR self-review
  // judges against. A group that arrives without one fails validation and routes to the schema-retry
  // loop — one more cheap Planner turn, against a whole PR nobody can check. The `.describe()` below
  // is what that retry re-asks with, so it names the shape of an answer rather than the field.
  acceptance: z
    .string()
    .min(1)
    .describe(
      'How to PROVE this group done: the command to run or the behaviour to observe, concrete enough to execute, no restating the title. E.g. "bun test src/auth passes and POST /login sets a session cookie".',
    ),
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

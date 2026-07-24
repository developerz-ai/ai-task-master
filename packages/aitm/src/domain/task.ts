// A single unit of work inside a PR group. Shared leaf type: the plan layer parses tasks out of
// markdown, the state layer persists them, and the subagents execute them — so the shape lives here,
// below all three, to keep them acyclic. See docs/state.md §"PrGroup sub-schema".

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

// Round-trips PR-group tasks to/from the checkbox markdown of `plan.md`.
// Mirrors claudetm's format so the checkbox ([ ] / [x]) is the on-disk source of
// per-task completion. SRP: markdown shape only — no I/O, no state-schema coupling.
// Format: `## Group: <title>` followed by `- [ ] [NORMAL] <task>` (complexity tag
// optional → `normal`). These are the ONLY checkboxes aitm writes anywhere.

import { type TaskComplexity, TaskComplexitySchema } from '../state/schema.ts';

export type PlanMarkdownTask = {
  text: string;
  complexity: TaskComplexity;
  done: boolean;
};

export type PlanMarkdownGroup = {
  title: string;
  tasks: PlanMarkdownTask[];
};

const GROUP_RE = /^## Group: (.*)$/;
const TASK_RE = /^- \[([ x])\] (?:\[(\w+)\] )?(.*)$/;

export function renderPlanMarkdown(groups: readonly PlanMarkdownGroup[]): string {
  return groups
    .map((group) => {
      const lines = group.tasks.map(
        (task) => `- [${task.done ? 'x' : ' '}] [${task.complexity.toUpperCase()}] ${task.text}`,
      );
      return [`## Group: ${group.title}`, ...lines].join('\n');
    })
    .join('\n\n');
}

export function parsePlanMarkdown(md: string): PlanMarkdownGroup[] {
  const groups: PlanMarkdownGroup[] = [];
  let current: PlanMarkdownGroup | undefined;

  for (const line of md.split(/\r?\n/)) {
    const groupMatch = GROUP_RE.exec(line);
    if (groupMatch) {
      current = { title: groupMatch[1] ?? '', tasks: [] };
      groups.push(current);
      continue;
    }

    const taskMatch = TASK_RE.exec(line);
    if (taskMatch && current) {
      current.tasks.push({
        text: taskMatch[3] ?? '',
        complexity: normalizeComplexity(taskMatch[2]),
        done: taskMatch[1] === 'x',
      });
    }
  }

  return groups;
}

function normalizeComplexity(raw: string | undefined): TaskComplexity {
  if (raw === undefined) return 'normal';
  const parsed = TaskComplexitySchema.safeParse(raw.toLowerCase());
  return parsed.success ? parsed.data : 'normal';
}

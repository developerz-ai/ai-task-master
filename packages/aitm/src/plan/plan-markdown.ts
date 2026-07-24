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

export type PlanMarkdownDiagnostic = {
  line: number;
  message: string;
};

export type PlanMarkdownResult = {
  groups: PlanMarkdownGroup[];
  diagnostics: PlanMarkdownDiagnostic[];
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

export function parsePlanMarkdown(md: string): PlanMarkdownResult {
  const groups: PlanMarkdownGroup[] = [];
  const diagnostics: PlanMarkdownDiagnostic[] = [];
  let current: PlanMarkdownGroup | undefined;
  let lineNum = 0;

  for (const line of md.split(/\r?\n/)) {
    lineNum++;
    const groupMatch = GROUP_RE.exec(line);
    if (groupMatch) {
      current = { title: groupMatch[1] ?? '', tasks: [] };
      groups.push(current);
      continue;
    }

    const taskMatch = TASK_RE.exec(line);
    if (taskMatch) {
      if (!current) {
        diagnostics.push({
          line: lineNum,
          message: 'task appears before any group heading',
        });
        continue;
      }
      const complexityTag = taskMatch[2];
      const complexity = normalizeComplexity(complexityTag);
      if (complexityTag && complexity === 'normal' && !isKnownComplexity(complexityTag)) {
        diagnostics.push({
          line: lineNum,
          message: `unknown complexity tag "[${complexityTag}]", fell back to "normal"`,
        });
      }
      current.tasks.push({
        text: taskMatch[3] ?? '',
        complexity,
        done: taskMatch[1] === 'x',
      });
    }
  }

  return { groups, diagnostics };
}

function isKnownComplexity(tag: string): boolean {
  return TaskComplexitySchema.safeParse(tag.toLowerCase()).success;
}

function normalizeComplexity(raw: string | undefined): TaskComplexity {
  if (raw === undefined) return 'normal';
  const parsed = TaskComplexitySchema.safeParse(raw.toLowerCase());
  return parsed.success ? parsed.data : 'normal';
}

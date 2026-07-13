// Model-facing surface for skills (issue #120). Two builders turn discovered `SkillDefinition`s
// (skills-loader.ts) into progressive disclosure:
//
//   - `skillIndexBlock` renders the always-visible tier — one `<name>: <description>` line per skill
//     plus the invocation contract — for the system prompt. Bodies never appear here.
//   - `skillTool` is the AI-SDK tool a subagent calls to pull a skill's body into context on demand
//     (the second tier); the body then directs on-demand reads of sibling `references/*` (the third).
//
// Both exclude skills whose `disable-model-invocation` frontmatter is `true`. Neither mounts anything
// itself — the caller passes the `skills` array, deciding what a given role may see (target-repo
// skills are untrusted and Worker-only; that wiring is a separate aitm-side issue).

import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { asString } from './frontmatter.ts';
import type { SkillDefinition } from './skills-loader.ts';

// Rendered as the index block's preamble: the blocking contract the model must follow.
export const SKILL_INVOCATION_CONTRACT =
  "Skills extend you with task-specific procedures. Each line below is `<name>: <description>`. When a skill's description matches the task at hand, you MUST call the `Skill` tool with that exact name and follow the instructions it returns before producing your answer — this is blocking, not optional. Never claim to have applied a skill without calling the tool, and only invoke names that appear in this list.";

const skillInputSchema = z.object({
  skill: z.string().min(1).describe('The exact name of a skill from the skills index.'),
  args: z
    .string()
    .optional()
    .describe('Free-form input for the skill; echoed back in the result for its instructions.'),
});
export type SkillToolInput = z.infer<typeof skillInputSchema>;
export type SkillToolOutput =
  | { ok: true; name: string; path: string; body: string; args?: string }
  | { ok: false; error: string };

// A skill is model-invocable unless it opts out with `disable-model-invocation: true`.
function isModelInvocable(skill: SkillDefinition): boolean {
  return asString(skill.extra['disable-model-invocation']).trim() !== 'true';
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

// The always-visible index tier: the invocation contract plus one line per model-invocable skill.
// Returns '' when nothing is invocable, so a caller can drop the block entirely.
export function skillIndexBlock(skills: readonly SkillDefinition[]): string {
  const invocable = skills.filter(isModelInvocable);
  if (invocable.length === 0) return '';
  const lines = invocable.map((s) => `${s.name}: ${oneLine(s.description)}`);
  return [SKILL_INVOCATION_CONTRACT, '<skills>', ...lines, '</skills>'].join('\n');
}

// The `Skill` tool: exact-name lookup over the model-invocable set. A hit returns the skill's body
// and absolute path; a miss returns an error result naming the available skills (never throws).
export function skillTool(
  skills: readonly SkillDefinition[],
): Tool<SkillToolInput, SkillToolOutput> {
  const invocable = skills.filter(isModelInvocable);
  const byName = new Map(invocable.map((s) => [s.name, s]));
  const available = invocable.map((s) => s.name);
  return tool({
    description:
      'Load a skill by name to pull its full instructions into context, then follow them before answering. Only names present in the skills index are valid. `args` is optional free-form text passed through to the skill.',
    inputSchema: skillInputSchema,
    execute: (input: SkillToolInput): SkillToolOutput => {
      const skill = byName.get(input.skill);
      if (skill === undefined) {
        const names = available.length > 0 ? available.join(', ') : '(none available)';
        return { ok: false, error: `Unknown skill "${input.skill}". Available skills: ${names}.` };
      }
      return {
        ok: true,
        name: skill.name,
        path: skill.path,
        body: skill.body,
        ...(input.args !== undefined ? { args: input.args } : {}),
      };
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: renderSkillResult(output) }),
  });
}

// Plain-text rendering so the body reads as instructions, not a JSON-escaped blob (issue #127).
function renderSkillResult(output: SkillToolOutput): string {
  if (!output.ok) return output.error;
  const header =
    output.args !== undefined && output.args !== ''
      ? `Skill: ${output.name}\nArguments: ${output.args}`
      : `Skill: ${output.name}`;
  return [
    header,
    '',
    output.body,
    '',
    `Files this skill references (e.g. references/*.md) live next to ${output.path}; read them on demand with the Read tool.`,
  ].join('\n');
}

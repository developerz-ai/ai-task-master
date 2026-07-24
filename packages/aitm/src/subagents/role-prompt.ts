// The one aitm-side system-prompt assembly (issue #105 + slice 08). Every built-in subagent (planner,
// worker manifest, per-file editor, reviewer, ci-fix worker, take-over flows) builds its prompt here, so
// the cross-cutting contracts land in exactly one place: a weak routed model can no longer skip the
// faithful-reporting or scope-discipline directives, and a new subagent that bypasses this helper is
// caught by test.
//
// This is the harness↔agent seam's front door. buildRolePrompt gathers the real-world context a pure
// template cannot (the `<env>` block reads cwd/platform/clock) and injects it, then routes through
// render('role-prompt', …). The template bakes in the contract blocks, step-budget, and block order; the
// caller supplies only slot values — no prompt text is hand-concatenated here. Imports stay one-way
// (role-prompt → prompts/templates → prompts/slots + compat) so the main loop and the flows it pulls in
// (ci-fix, take-over) share it without an import cycle.

import {
  contextReminder,
  detectGitRepo,
  envBlock,
  type MemoryIndexEntry,
  SYSTEM_REMINDER_CONTRACT,
} from '@developerz.ai/ai-claude-compat';
import { render } from './prompts/templates.ts';

export type RolePromptInput = {
  // Coding-style digest (StyleDistiller output, or raw agent-config contents). Empty → omitted.
  style: string;
  // The role's session guidance — today's role-prefix constant. Rendered as the sessionGuidance block.
  roleGuidance: string;
  // Checkout cwd for the <env> block.
  cwd: string;
  // Resolved model id for the self-identification block. Omitted → no selfId block (e.g. the editor,
  // which holds only a model handle, not a resolved id).
  modelId?: string;
  // Optional knowledge cutoff for the selfId block; no production source wires one yet.
  knowledgeCutoff?: string;
  // Per-repo memory index (issue #118). Empty/absent → no memory block at all.
  memoryIndex?: readonly MemoryIndexEntry[];
};

// Compute the impure `<env>` block from the checkout cwd, then hand every slot to the role-prompt
// template. The template owns canonical order and the always-on contract blocks — this function only
// supplies values.
export function buildRolePrompt(input: RolePromptInput): string {
  const env = envBlock({ cwd: input.cwd, isGitRepo: detectGitRepo(input.cwd) });
  return render('role-prompt', {
    roleGuidance: input.roleGuidance,
    style: input.style,
    env,
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(input.knowledgeCutoff !== undefined ? { knowledgeCutoff: input.knowledgeCutoff } : {}),
    ...(input.memoryIndex !== undefined ? { memoryIndex: input.memoryIndex } : {}),
  });
}

// System prompt for a main-loop agent whose tool set is decorated with reminders (issue #106): the
// role's block-pipeline prompt (issue #105) plus the provenance contract, so the model treats
// <system-reminder> content as advisory harness context, not user intent. Lives here (not in
// run-loop-adapter) so the flows that reuse the decorated tool sets — the CI-fix worker and the
// take-over reviewer (issue #141) — share it without importing back into the adapter (import cycle).
export function reminderAgentSystemPrompt(input: RolePromptInput): string {
  return `${buildRolePrompt(input)}\n\n${SYSTEM_REMINDER_CONTRACT}`;
}

// The BYTE-STABLE leading context block prepended to every reminder-decorated subagent's first user
// message: today's date, framed as advisory <system-reminder> context (issue #106). It carries no
// per-step content, so the leading prompt prefix is identical across every call in a conversation
// (and across a run's calls within a day) — the provider's prompt cache holds instead of being
// invalidated by a moving prefix. The date stays day-granular for the same reason. The run's Step
// N/M position and the repo style digest stay OUT (the former rides a trailing reminder so it never
// busts the cached prefix; the latter is already single-sourced in the system prompt).
export function harnessContextBlock(): string {
  return contextReminder([{ label: 'currentDate', body: new Date().toISOString().slice(0, 10) }]);
}

export type EditorRolePromptInput = {
  // Coding-style digest, already capped by the caller. Empty → omitted.
  style: string;
  // EDITOR_SYSTEM_PREFIX.
  roleGuidance: string;
  // Checkout cwd for the <env> block.
  cwd: string;
  // Optional shared team brief (task + full manifest + rolling context) injected when the fanout splits
  // across multiple leaves. Empty/absent → no brief, so a lone editor's prompt stays byte-identical.
  teamBrief?: string;
};

// Lean-leaf variant of buildRolePrompt for the per-file editor (worker.ts's Layer B fanout): drops
// the contract blocks, self-id, and memory index that buildRolePrompt bakes in for the Coordinator
// and other non-leaf roles — an editor cannot spawn, delegate, or see the plan, so the governance
// text that constrains those behaviors is dead weight paid ×N per manifest. Keeps roleGuidance,
// style, and `<env>` — an editor still writes code and needs both.
export function buildEditorRolePrompt(input: EditorRolePromptInput): string {
  const env = envBlock({ cwd: input.cwd, isGitRepo: detectGitRepo(input.cwd) });
  return render('editor-prompt', {
    roleGuidance: input.roleGuidance,
    style: input.style,
    env,
    ...(input.teamBrief ? { teamBrief: input.teamBrief } : {}),
  });
}

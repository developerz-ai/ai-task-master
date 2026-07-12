// The one aitm-side system-prompt assembly (issue #105). Every built-in subagent (planner, worker
// manifest, per-file editor, reviewer, ci-fix worker, take-over flows) builds its prompt here, so the
// cross-cutting contracts land in exactly one place: a weak routed model can no longer skip the
// faithful-reporting or scope-discipline directives, and a new subagent that bypasses this helper is
// caught by test.
//
// A leaf module (imports only the compat block pipeline) so both the main loop (run-loop-adapter) and
// the flows it pulls in (ci-fix, take-over) can share it without an import cycle.

import {
  composeSystemPrompt,
  defaultContractBlocks,
  detectGitRepo,
  envBlock,
  type MemoryIndexEntry,
  memoryIndexBlock,
  type PromptBlock,
  selfIdBlock,
  stepBudgetLine,
} from '@developerz.ai/ai-claude-compat';

export type RolePromptInput = {
  // Coding-style digest (StyleDistiller output, or raw agent-config contents). Empty → omitted.
  style: string;
  // The role's session guidance — today's role-prefix constant. Rendered as the sessionGuidance block.
  roleGuidance: string;
  // Worktree cwd for the <env> block.
  cwd: string;
  // The role's effective step budget, surfaced as the step-budget reminder so exhaustion isn't silent.
  maxSteps: number;
  // Resolved model id for the self-identification block. Omitted → no selfId block (e.g. the editor,
  // which holds only a model handle, not a resolved id).
  modelId?: string;
  // Optional knowledge cutoff for the selfId block; no production source wires one yet.
  knowledgeCutoff?: string;
  // Per-repo memory index (issue #118). Empty/absent → no memory block at all.
  memoryIndex?: readonly MemoryIndexEntry[];
};

// Assemble a subagent system prompt from the ordered block pipeline: the always-on contract blocks
// (harness / communication / autonomy) + optional self-id + the role guidance (with its step budget)
// + style + env. Canonical order and separation are the pipeline's job.
export function buildRolePrompt(input: RolePromptInput): string {
  const memoryBlock = input.memoryIndex ? memoryIndexBlock(input.memoryIndex) : null;
  const blocks: PromptBlock[] = [
    ...defaultContractBlocks(),
    ...(input.modelId ? [selfIdBlock(input.modelId, input.knowledgeCutoff)] : []),
    {
      kind: 'sessionGuidance',
      text: `${input.roleGuidance}\n\n${stepBudgetLine(input.maxSteps)}`,
    },
    { kind: 'style', text: input.style },
    { kind: 'env', text: envBlock({ cwd: input.cwd, isGitRepo: detectGitRepo(input.cwd) }) },
    ...(memoryBlock ? [memoryBlock] : []),
  ];
  return composeSystemPrompt(blocks);
}

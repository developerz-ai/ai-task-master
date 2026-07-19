// Named prompt-template registry + the typed render() seam (slice 08). Every built-in subagent prompt
// is assembled by ONE call to render(name, slots): the template owns layout and, for each untrusted
// input, routes it through a `data` slot (auto-fenced). Call sites supply raw values and cannot leak an
// unfenced review comment or specialist file — the fencing is structural, not per-call-site discipline.
//
// Templates are PURE: they read only their slot record — no process env, cwd, clock, or module state —
// so a rendered prompt is a deterministic function of its inputs (snapshot-testable). The role-prompt
// template bakes the always-on contract blocks and the step-budget reminder in from pure module
// constants; the impure `<env>` block is computed by the harness (buildRolePrompt) and injected as a
// slot, so the template itself stays pure.

import {
  defaultContractBlocks,
  type MemoryIndexEntry,
  memoryIndexBlock,
  type PromptBlock,
  renderPromptBlocks,
  selfIdBlock,
  stepBudgetLine,
} from '@developerz.ai/ai-claude-compat';
import { data, instruction, renderSlot } from './slots.ts';

// Reviewer thread prompt: trusted framing (PR / thread / file coordinates + the decide-act-submit ask)
// followed by the untrusted external review conversation, fenced as <review-comment>.
export type ReviewThreadSlots = {
  // Harness-authored framing, rendered verbatim (coordinates + the ask).
  readonly context: string;
  // The external reviewer conversation — untrusted; auto-fenced as a <review-comment> data region.
  readonly comment: string;
};

function reviewThread(slots: ReviewThreadSlots): string {
  return [
    renderSlot(instruction(slots.context)),
    '',
    renderSlot(data('review-comment', slots.comment)),
  ].join('\n');
}

// Specialist-guidance overlay: the Worker's trusted base guidance, then the target repo's own
// `.claude/agents/*.md` domain guidance fenced as <specialist-guidance> BELOW the base — so the
// immutable contract always precedes the advisory overlay and cannot be displaced by it.
export type SpecialistGuidanceSlots = {
  // The Worker's base role guidance, rendered verbatim (trusted).
  readonly base: string;
  // The repo-shipped specialist system prompt — untrusted; auto-fenced as <specialist-guidance>.
  readonly guidance: string;
};

function specialistGuidance(slots: SpecialistGuidanceSlots): string {
  return [
    renderSlot(instruction(slots.base)),
    '',
    renderSlot(data('specialist-guidance', slots.guidance)),
  ].join('\n');
}

// Role system-prompt frame: the always-on contract blocks + self-id + the role's own guidance (with its
// step-budget reminder) + style + `<env>` + memory, rendered in the #105 canonical block order. Every
// built-in role (planner / worker / editor / reviewer, and the take-over/ci-fix/conflict flows) renders
// through this one template behind buildRolePrompt — the contract blocks and step-budget are the
// template's job, so no call path can drop them. The role's prose is a slot, not a per-role template.
export type RolePromptSlots = {
  // The role's own session guidance — a `*_SYSTEM_PREFIX` prose const. Trusted, verbatim.
  readonly roleGuidance: string;
  // The role's effective step budget; interpolated into the baked-in step-budget reminder.
  readonly maxSteps: number;
  // Coding-style digest (StyleDistiller output). Empty → the style block is omitted.
  readonly style: string;
  // The pre-rendered `<env>` block. Computed by the harness (it reads cwd/platform/clock) and injected
  // so this template stays pure.
  readonly env: string;
  // Resolved model id for the self-id block. Omitted → no self-id block (e.g. the editor path).
  readonly modelId?: string;
  // Optional knowledge cutoff for the self-id block.
  readonly knowledgeCutoff?: string;
  // Per-repo memory index (issue #118). Empty/absent → no memory block.
  readonly memoryIndex?: readonly MemoryIndexEntry[];
};

function rolePrompt(slots: RolePromptSlots): string {
  const memory = slots.memoryIndex ? memoryIndexBlock(slots.memoryIndex) : null;
  const blocks: PromptBlock[] = [
    ...defaultContractBlocks(),
    ...(slots.modelId ? [selfIdBlock(slots.modelId, slots.knowledgeCutoff)] : []),
    {
      kind: 'sessionGuidance',
      text: `${slots.roleGuidance}\n\n${stepBudgetLine(slots.maxSteps)}`,
    },
    { kind: 'style', text: slots.style },
    { kind: 'env', text: slots.env },
    ...(memory ? [memory] : []),
  ];
  return renderPromptBlocks(blocks);
}

// Editor-leaf system prompt: role guidance + step-budget, style, and `<env>` only — no contract
// blocks, no self-id, no memory index. Mirrors the `explore` leaf's contract-free pattern (a leaf
// can't spawn/delegate, so the harness/communication/autonomy governance text it exists to constrain
// doesn't apply), but unlike `explore` the editor writes code, so it keeps the style digest and the
// `<env>` block a code-writing leaf still needs. Fans out once per manifest file, so trimming the
// per-call frame here compounds across the whole fanout.
export type EditorPromptSlots = {
  // EDITOR_SYSTEM_PREFIX. Trusted, verbatim.
  readonly roleGuidance: string;
  // The editor's step budget; interpolated into the baked-in step-budget reminder.
  readonly maxSteps: number;
  // Coding-style digest, already capped by the caller. Empty → the style block is omitted.
  readonly style: string;
  // The pre-rendered `<env>` block.
  readonly env: string;
  // Shared team brief injected after the role guidance when the fanout splits across leaves. Empty/
  // absent → omitted, so a lone editor's prompt is byte-identical to the pre-team fanout.
  readonly teamBrief?: string;
};

function editorPrompt(slots: EditorPromptSlots): string {
  const guidance = `${slots.roleGuidance}\n\n${stepBudgetLine(slots.maxSteps)}`;
  return renderPromptBlocks([
    {
      kind: 'sessionGuidance',
      text: slots.teamBrief ? `${guidance}\n\n${slots.teamBrief}` : guidance,
    },
    { kind: 'style', text: slots.style },
    { kind: 'env', text: slots.env },
  ]);
}

// Orchestrator top-level system prompt: the coding-style digest, the orchestrator role guidance, and
// the rolling summary of prior PRs. All three are harness-authored (aitm's own governance prose and its
// own run summary — nothing external is concatenated here), so all three are trusted instruction slots.
// Routed through render() so the top agent shares the one prompt-assembly seam; if a later slice needs
// to fence an untrusted value, it flips a slot kind HERE, not at the call site.
export type OrchestratorSystemSlots = {
  // Coding-style digest (StyleDistiller output or raw agent-config contents). Trusted, verbatim.
  readonly style: string;
  // The orchestrator role prefix (ORCHESTRATOR_ROLE_PREFIX). Trusted, verbatim.
  readonly roleGuidance: string;
  // Rolling summary of prior PRs in this run (aitm-authored). Trusted, verbatim.
  readonly rollingContext: string;
};

function orchestratorSystem(slots: OrchestratorSystemSlots): string {
  return [
    renderSlot(instruction(slots.style)),
    renderSlot(instruction(slots.roleGuidance)),
    renderSlot(instruction(slots.rollingContext)),
  ].join('\n');
}

// The registry: template name → its slot shape. Every built-in subagent/orchestrator prompt renders
// through one of these — there is no hand-concat call site left, so nothing can slip a value into a
// prompt outside the trust boundary.
export type PromptSlots = {
  'review-thread': ReviewThreadSlots;
  'specialist-guidance': SpecialistGuidanceSlots;
  'role-prompt': RolePromptSlots;
  'editor-prompt': EditorPromptSlots;
  'orchestrator-system': OrchestratorSystemSlots;
};

export type PromptName = keyof PromptSlots;

const TEMPLATES: { [N in PromptName]: (slots: PromptSlots[N]) => string } = {
  'review-thread': reviewThread,
  'specialist-guidance': specialistGuidance,
  'role-prompt': rolePrompt,
  'editor-prompt': editorPrompt,
  'orchestrator-system': orchestratorSystem,
};

// The single prompt-assembly seam. Look up the named template and apply it to its typed slots. `name`
// is statically constrained to a registered template, so an unknown name is a compile error — there is
// no string-concatenation fallback for a value to slip through unfenced.
export function render<N extends PromptName>(name: N, slots: PromptSlots[N]): string {
  return TEMPLATES[name](slots);
}

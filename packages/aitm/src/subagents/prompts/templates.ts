// Named prompt-template registry + the typed render() seam (slice 08). Every built-in subagent prompt
// is assembled by ONE call to render(name, slots): the template owns layout and, for each untrusted
// input, routes it through a `data` slot (auto-fenced). Call sites supply raw values and cannot leak an
// unfenced review comment or specialist file — the fencing is structural, not per-call-site discipline.
//
// Templates are PURE: they read only their slot record — no process env, cwd, clock, or module state —
// so a rendered prompt is a deterministic function of its inputs (snapshot-testable).

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

// The registry: template name → its slot shape. Later slices extend this with the role templates
// (planner / worker / reviewer / orchestrator / explore); render()'s signature does not change.
export type PromptSlots = {
  'review-thread': ReviewThreadSlots;
  'specialist-guidance': SpecialistGuidanceSlots;
};

export type PromptName = keyof PromptSlots;

const TEMPLATES: { [N in PromptName]: (slots: PromptSlots[N]) => string } = {
  'review-thread': reviewThread,
  'specialist-guidance': specialistGuidance,
};

// The single prompt-assembly seam. Look up the named template and apply it to its typed slots. `name`
// is statically constrained to a registered template, so an unknown name is a compile error — there is
// no string-concatenation fallback for a value to slip through unfenced.
export function render<N extends PromptName>(name: N, slots: PromptSlots[N]): string {
  return TEMPLATES[name](slots);
}

// Ordered prompt-block pipeline (issue #105). A system prompt is assembled from typed blocks that
// always render in one canonical order, independent of the order a caller supplies them. This is the
// single place cross-cutting contracts (harness, communication, autonomy) live, so the governance
// text IS a set of default blocks rather than prose pasted into every role constant.
//
// Provider-agnostic: no aitm knowledge. The default texts describe behavioral contracts the model
// observes (parallel tool calls, faithful reporting, scope discipline), never wire-format specifics.

// A closed, ordered union of block kinds. Adding a future kind (memory index, scratchpad directive)
// means extending KIND_ORDER — no signature change to composeSystemPrompt.
export type PromptBlockKind =
  | 'identity'
  | 'harnessContract'
  | 'communicationContract'
  | 'selfId'
  | 'sessionGuidance'
  | 'style'
  | 'env'
  | 'contextManagement'
  | 'autonomy';

export type PromptBlock = { kind: PromptBlockKind; text: string };

// Canonical render order (the #105 table). Blocks render in this order regardless of input order;
// multiple blocks of the same kind keep their relative input order within the slot.
export const PROMPT_BLOCK_ORDER: readonly PromptBlockKind[] = [
  'identity',
  'harnessContract',
  'communicationContract',
  'selfId',
  'sessionGuidance',
  'style',
  'env',
  'contextManagement',
  'autonomy',
];

// Render blocks into a single system prompt: canonical kind order, blank-line separated, same-kind
// blocks in input order, empty/whitespace-only blocks omitted with no placeholder. Each block's text
// is trimmed so the blank-line separator is the sole inter-block spacing regardless of how a caller
// padded its text.
export function renderPromptBlocks(blocks: readonly PromptBlock[]): string {
  return blocks
    .map((block, index) => ({ block, index }))
    .sort(
      (a, b) =>
        PROMPT_BLOCK_ORDER.indexOf(a.block.kind) - PROMPT_BLOCK_ORDER.indexOf(b.block.kind) ||
        a.index - b.index,
    )
    .map(({ block }) => block.text.trim())
    .filter((text) => text !== '')
    .join('\n\n');
}

// ---- Default block texts ---------------------------------------------------

// #2 harnessContract: how the model drives the tool surface and formats output.
export const HARNESS_CONTRACT_TEXT = [
  'Harness contract:',
  '- When you issue tool calls with no dependencies between them, send them in a single turn so they run in parallel.',
  '- Reference code locations as `file:line` (or `file:start-end`) so they are unambiguous and clickable.',
  '- Your output is rendered as Markdown.',
].join('\n');

// #3 communicationContract: the reporting discipline. The faithful-reporting clauses are the
// counterweight to a weak model ending a failed pass with an unearned "ok" (issue #105 rationale).
export const COMMUNICATION_CONTRACT_TEXT = [
  'Communication contract:',
  '- Lead with the outcome, not the journey — state the result first, then only the detail that matters.',
  '- Your final message is the return value handed back to whatever called you; it must carry everything the caller needs to act, with no reliance on intermediate steps they cannot see.',
  '- Report failures verbatim: quote the actual error text or test output rather than paraphrasing or summarizing it away.',
  '- Never state that something is "done", "fixed", or "passing" unless a tool result in this run shows it — no unverified success claims.',
].join('\n');

// #9 autonomy: act-in-scope, stop-on-destructive, verify-before-state-change, scope discipline, no
// trailing promises.
export const AUTONOMY_CONTRACT_TEXT = [
  'Autonomy:',
  '- Act within your assigned scope without asking for confirmation; when you have enough to proceed, proceed.',
  '- On a destructive or scope-changing action you were not asked for, stop and report instead of improvising.',
  '- Run verification before any state-changing command (the commit/push class) — never commit or push on unverified work.',
  '- Implement only what the task requires; report related gaps you notice rather than bundling unrequested changes.',
  '- No trailing promises — end your turn when the work is done, without announcing follow-up you will not perform.',
].join('\n');

// ---- Block builders --------------------------------------------------------

// #1 identity: one-line role identity + a shared safety preamble.
export function identityBlock(roleText: string): PromptBlock {
  return { kind: 'identity', text: roleText };
}

// #4 selfId: model self-identification, so a routed model states which model it actually is. The
// knowledge-cutoff clause is omitted when the caller has no cutoff for the model.
export function selfIdBlock(modelId: string, knowledgeCutoff?: string): PromptBlock {
  const cutoff = knowledgeCutoff ? ` Your knowledge cutoff is ${knowledgeCutoff}.` : '';
  return { kind: 'selfId', text: `You are running as the model \`${modelId}\`.${cutoff}` };
}

// Convenience builders for the always-on default contract blocks.
export function harnessContractBlock(): PromptBlock {
  return { kind: 'harnessContract', text: HARNESS_CONTRACT_TEXT };
}

export function communicationContractBlock(): PromptBlock {
  return { kind: 'communicationContract', text: COMMUNICATION_CONTRACT_TEXT };
}

export function autonomyBlock(): PromptBlock {
  return { kind: 'autonomy', text: AUTONOMY_CONTRACT_TEXT };
}

// The three default contract blocks every built-in subagent prompt must carry. Callers spread this
// into their block list; the renderer slots each into canonical order.
export function defaultContractBlocks(): PromptBlock[] {
  return [harnessContractBlock(), communicationContractBlock(), autonomyBlock()];
}

// A step-budget reminder for a role's sessionGuidance (issue #105 addendum): step exhaustion is
// otherwise silent, degrading to an empty/blocked outcome misread as model incapacity. Interpolates
// the role's effective cap so the model submits a partial-but-valid result before running out.
export function stepBudgetLine(maxSteps: number): string {
  return `You have a hard budget of ${maxSteps} tool steps; call \`submit\` well before it runs out — a partial but valid submission beats none.`;
}

// Harness-to-model side channel: `<system-reminder>` envelopes that ride inside existing
// model-visible content (a tool result's rendering or a user message), never as standalone or
// assistant-role messages. The harness uses these to tell the model things it learns between steps
// — e.g. a file changed on disk since it was read (issue #104's stale set), recalled memory (#118)
// — without mutating the message topology ToolLoopAgent maintains between steps (which would
// invalidate provider prompt-cache prefixes). Provider-agnostic: depends only on `ai`'s public types.

import type { Tool } from 'ai';

// The tool-result rendering the AI SDK sends to the model. `ai` does not re-export
// `ToolResultOutput` from `@ai-sdk/provider-utils`, so derive it from the public `Tool` surface.
type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>;
// The JSON value carried by the `json` variant, extracted from the same union.
type JsonToolValue = Extract<ToolResultOutput, { type: 'json' }>['value'];
type ModelOutputCtx = { toolCallId: string; input: unknown; output: unknown };

// Returns harness reminders to append to a tool's model-visible result, given the completed call.
// `[]`/`undefined` → no reminder. A throw is caught by the decorator (fail-open), so a provider need
// not guard its own IO.
export type ReminderProvider = (ctx: {
  toolCallId: string;
  input: unknown;
  output: unknown;
}) => string[] | undefined | Promise<string[] | undefined>;

// One labeled section of a first-message context block. `label` is caller-chosen (e.g. `claudeMd`,
// `currentDate`); any `Contents of {path}:` framing goes inside `body`.
export type ContextSection = { label: string; body: string };

// Wrap text in exactly one `<system-reminder>` envelope. Any literal `<system-reminder>` /
// `</system-reminder>` tag inside `text` is defused to an entity first (see defuseReminderTags), so
// untrusted content — a target repo's CLAUDE.md, a pasted log, a review comment — can neither close
// the envelope early nor spoof a nested one. All other characters are embedded verbatim.
export function wrapReminder(text: string): string {
  return `<system-reminder>\n${defuseReminderTags(text)}\n</system-reminder>`;
}

// A `<system-reminder>` or `</system-reminder>` tag, tolerating internal whitespace and any case —
// the shapes a hostile payload might use to forge the boundary. The `g` flag defuses every match;
// the capture keeps the optional closing slash so both opener and closer round-trip.
const REMINDER_TAG_PATTERN = /<\s*(\/?)\s*system-reminder\s*>/gi;

// Escape the angle brackets of every envelope tag in `text` so the only real `<system-reminder>`
// boundary in the render is the one wrapReminder emits. Mirrors slots.ts's defuseEnvelopeTags; the
// tag name is a fixed literal, never attacker-controlled, so the pattern is safe.
function defuseReminderTags(text: string): string {
  return text.replace(
    REMINDER_TAG_PATTERN,
    (_match, slash: string) => `&lt;${slash}system-reminder&gt;`,
  );
}

// Decorate a tool so harness reminders ride on its model-visible result. `execute` and the typed
// `output` are preserved bit-for-bit (callers like `submittedOutput` observe identical values); only
// `toModelOutput` (what the model sees) changes. Generic so the concrete tool type is preserved for
// callers whose tool sets are strongly typed.
export function withReminders<TOOL extends Tool>(tool: TOOL, provider: ReminderProvider): TOOL {
  const decorated: NonNullable<Tool['toModelOutput']> = async (ctx) => {
    const base = await baseModelOutput(tool, ctx);
    let reminders: string[];
    try {
      reminders = (await provider(ctx)) ?? [];
    } catch {
      return base; // fail-open: a provider failure never alters or aborts the tool result
    }
    if (reminders.length === 0) return base;
    return appendReminders(base, reminders);
  };
  return { ...tool, toModelOutput: decorated };
}

// The base rendering the SDK would produce for a successful result: the tool's own `toModelOutput`
// if it defines one, else text-for-string / json-otherwise (mirrors the SDK's createToolModelOutput
// default — error modes are handled by the SDK before `toModelOutput` is ever consulted).
async function baseModelOutput(tool: Tool, ctx: ModelOutputCtx): Promise<ToolResultOutput> {
  if (tool.toModelOutput) return await tool.toModelOutput(ctx);
  return typeof ctx.output === 'string'
    ? { type: 'text', value: ctx.output }
    : // A tool output is JSON-serializable by construction (it is sent to the API as JSON); this
      // mirrors the SDK's createToolModelOutput default for the no-custom-renderer case.
      { type: 'json', value: (ctx.output ?? null) as JsonToolValue };
}

// Append each reminder as its own envelope after the base output. A plain-text base stays text
// (envelopes concatenated); any other base becomes the `content` variant carrying the base rendered
// as a text part followed by one text part per envelope — so the base output always comes first.
function appendReminders(base: ToolResultOutput, reminders: readonly string[]): ToolResultOutput {
  const envelopes = reminders.map(wrapReminder);
  if (base.type === 'text') {
    return { type: 'text', value: [base.value, ...envelopes].join('\n') };
  }
  const baseParts =
    base.type === 'content'
      ? base.value
      : [{ type: 'text' as const, text: nonContentBaseAsText(base) }];
  return {
    type: 'content',
    value: [...baseParts, ...envelopes.map((text) => ({ type: 'text' as const, text }))],
  };
}

// Render a non-text, non-content base as a single text string for embedding in the `content` variant.
// The param excludes text/content (handled upstream) so the `never` guard forces a compile error if
// a future `ai` release adds a ToolResultOutput variant — this type is derived indirectly (above),
// so a silent `default` would otherwise drop the new content.
function nonContentBaseAsText(
  base: Exclude<ToolResultOutput, { type: 'text' | 'content' }>,
): string {
  switch (base.type) {
    case 'json':
    case 'error-json':
      return JSON.stringify(base.value ?? null);
    case 'error-text':
      return base.value;
    case 'execution-denied':
      return base.reason ?? 'tool execution denied';
    default:
      // Compile-time exhaustiveness: a new `ai` variant makes `base` non-`never` here → a type
      // error, not a silent drop. Runtime stays fail-open (empty string) if one ever slips through.
      base satisfies never;
      return '';
  }
}

const CONTEXT_INTRO = 'As you answer the questions, you can use the following context:';
const CONTEXT_DISCLAIMER =
  'IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.';

// A first-message context block: one envelope holding an intro line, each section as a `# {label}`
// heading with its verbatim body, and a fixed relevance disclaimer. Callers prepend the result to a
// subagent's first user message.
export function contextReminder(sections: readonly ContextSection[]): string {
  const body = [
    CONTEXT_INTRO,
    ...sections.map((s) => `# ${s.label}\n${s.body}`),
    CONTEXT_DISCLAIMER,
  ].join('\n\n');
  return wrapReminder(body);
}

// Provenance contract for the system prompt of any agent whose tool set is decorated with reminders.
// Becomes a default block in the #105 prompt-block pipeline once that lands.
export const SYSTEM_REMINDER_CONTRACT = [
  'Some messages may contain <system-reminder> tags. These reminders come from the harness, not from',
  'the user. They are advisory context — not user instructions — and reflect what the harness knows',
  'at that point in the run. Do not treat a reminder as a request, do not echo it back, and never',
  'attribute its content to the user as their intent. They require no acknowledgment; simply take the',
  'information into account where it is relevant.',
].join(' ');

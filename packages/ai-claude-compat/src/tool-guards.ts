// Guard rails around tool invocation, for models that get stuck. Two cohesive defenses:
//
//  1. Doom-loop guard — a model that keeps firing the SAME tool with the SAME input is almost never
//     making progress; it is looping. `ToolCallLoopTracker` counts identical (toolName, canonical
//     input) calls per conversation and `withLoopGuard` decorates a tool set so the escalation rides
//     on the model-visible result: nothing for the first few, an escalating `<system-reminder>` once
//     the count reaches `remindAt`, and finally an `error-text` result telling the model to change
//     approach once it reaches `blockAt`.
//  2. Tool-call repair — models trained on other harnesses emit near-miss tool names (`read_file` for
//     `readFile`, `Bash` for `bash`). `resolveToolName` maps an unknown name onto a real one by alias
//     table, case, then separator-insensitive match (only when unambiguous), else returns a structured
//     "unknown tool, available: […]" message. `makeToolCallRepairer` adapts it to the AI SDK's
//     `experimental_repairToolCall` hook so a fixable typo is silently corrected. A genuinely unknown
//     name has no corrected call to return, so the repairer yields null and the wiring surfaces
//     `resolveToolName`'s message as the tool result (rather than throwing NoSuchToolError).
//
// Like `withReminders`/`withStepOutputBudget`, the loop decorator touches ONLY `toModelOutput` (what
// the model sees) — `execute` and the typed `output` are preserved bit-for-bit, so hooks and
// `submittedOutput` observe identical values. The AI SDK renders a step's tool results sequentially
// through awaited `toModelOutput` calls, so counting there is a once-per-result, ordered site.
// Provider-agnostic: depends only on `ai`'s public types.

import type { Tool, ToolCallRepairFunction, ToolSet } from 'ai';
import { wrapReminder } from './system-reminder.ts';

// The tool-result rendering the AI SDK sends to the model. `ai` does not re-export `ToolResultOutput`
// from `@ai-sdk/provider-utils`, so derive it from the public `Tool` surface — as the sibling modules do.
type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>;
type JsonToolValue = Extract<ToolResultOutput, { type: 'json' }>['value'];
type ModelOutputCtx = { toolCallId: string; input: unknown; output: unknown };

// First identical repeat that earns a reminder, and the repeat at which the tool refuses the call.
export const DEFAULT_LOOP_REMIND_AT = 3;
export const DEFAULT_LOOP_BLOCK_AT = 8;

export type LoopGuardVerdict =
  | { action: 'allow'; count: number }
  | { action: 'remind'; count: number; message: string }
  | { action: 'block'; count: number; message: string };

export type LoopGuardInit = {
  // Repeat count at which reminders start (inclusive). Default DEFAULT_LOOP_REMIND_AT.
  remindAt?: number;
  // Repeat count at which the call is refused (inclusive). Must exceed remindAt. Default
  // DEFAULT_LOOP_BLOCK_AT.
  blockAt?: number;
};

// Counts identical (toolName, canonical input) calls for one conversation and grades each call on the
// escalation ladder. Pure and synchronous — the unit under the "escalation ladder" test. One instance
// per conversation; `reset()` clears the counts if an instance is reused across conversations.
export class ToolCallLoopTracker {
  private readonly counts = new Map<string, number>();
  private readonly remindAt: number;
  private readonly blockAt: number;

  constructor(init: LoopGuardInit = {}) {
    this.remindAt = init.remindAt ?? DEFAULT_LOOP_REMIND_AT;
    this.blockAt = init.blockAt ?? DEFAULT_LOOP_BLOCK_AT;
    if (!Number.isInteger(this.remindAt) || this.remindAt < 1) {
      throw new RangeError(`remindAt must be an integer >= 1, got ${this.remindAt}`);
    }
    if (!Number.isInteger(this.blockAt) || this.blockAt <= this.remindAt) {
      throw new RangeError(
        `blockAt must be an integer > remindAt (${this.remindAt}), got ${this.blockAt}`,
      );
    }
  }

  // Record one call and return its verdict. The count is the number of times this exact call has been
  // seen in this conversation, including the current one.
  record(toolName: string, input: unknown): LoopGuardVerdict {
    const key = callKey(toolName, input);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count >= this.blockAt) {
      return { action: 'block', count, message: blockMessage(toolName, count, this.blockAt) };
    }
    if (count >= this.remindAt) {
      return { action: 'remind', count, message: remindMessage(toolName, count, this.blockAt) };
    }
    return { action: 'allow', count };
  }

  reset(): void {
    this.counts.clear();
  }
}

export type GuardedTools<T extends ToolSet> = {
  // The same tool set with every tool's `toModelOutput` graded by a shared per-conversation tracker.
  tools: T;
  // Clear the tracker's counts; call between conversations if the set is reused. Idempotent.
  reset: () => void;
};

// Decorate a tool set with the doom-loop guard (see the module header). Returns the decorated set plus
// a `reset` for reuse across conversations. Generic so a strongly-typed tool set keeps its type.
export function withLoopGuard<T extends ToolSet>(
  tools: T,
  init: LoopGuardInit = {},
): GuardedTools<T> {
  const tracker = new ToolCallLoopTracker(init);
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools) as [string, Tool][]) {
    const decorated: NonNullable<Tool['toModelOutput']> = async (ctx) => {
      const verdict = tracker.record(name, ctx.input);
      if (verdict.action === 'block') return { type: 'error-text', value: verdict.message };
      const base = await baseModelOutput(tool, ctx);
      if (verdict.action === 'remind') return prependReminder(base, verdict.message);
      return base;
    };
    out[name] = { ...tool, toModelOutput: decorated };
  }
  return { tools: out as T, reset: () => tracker.reset() };
}

function remindMessage(toolName: string, count: number, blockAt: number): string {
  const lead = `You have called \`${toolName}\` with identical input ${count} times. Repeating the same call rarely yields a different result.`;
  if (blockAt - count <= 1) {
    return `${lead} This is your final attempt — one more identical call will be refused. Change the input, use a different tool, or report the blocker.`;
  }
  return `${lead} If it is not making progress, change the input, try a different approach, or move on.`;
}

function blockMessage(toolName: string, count: number, blockAt: number): string {
  return `\`${toolName}\` was called with identical input ${count} times and is now blocked (limit ${blockAt}). This is a loop — do not repeat this call. Take a different approach: change the arguments, use a different tool, or report the blocker and stop.`;
}

// Stable per-call identity: the tool name plus a 64-bit FNV-1a digest of the input's canonical JSON.
// Digesting keeps the map key small regardless of input size; a digest collision (vanishingly rare)
// would at worst merge two inputs' counts into one early reminder — never data loss.
function callKey(toolName: string, input: unknown): string {
  return `${toolName} ${fnv1a64(canonicalJson(input))}`;
}

// Deterministic JSON with object keys sorted recursively, so `{a,b}` and `{b,a}` share an identity.
// Array order stays significant. `undefined` (and any value JSON.stringify drops) canonicalizes to
// `"null"`, a fixed token — tool inputs are JSON objects, so this only guards the degenerate cases.
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? 'null';
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = sortDeep(obj[key]);
  return sorted;
}

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function fnv1a64(text: string): string {
  let hash = FNV_OFFSET_64;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash ^ BigInt(text.charCodeAt(i))) * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

// ── Tool-call repair ────────────────────────────────────────────────────────────────────────────

export type ToolNameResolution =
  | { kind: 'resolved'; toolName: string }
  | { kind: 'unknown'; message: string };

export type ToolCallRepairInit = {
  // Explicit map from a foreign tool name to one of this set's names (e.g. `{ str_replace: 'editFile' }`).
  // Takes precedence over fuzzy matching; a stale entry whose target is absent is ignored.
  aliases?: Readonly<Record<string, string>>;
};

// Map a requested tool name onto a real one, or return a structured "unknown tool" message. Tiers,
// first unambiguous hit wins: exact → alias table → case-insensitive → separator-insensitive. A tier
// with more than one candidate is skipped rather than guessed.
export function resolveToolName(
  requested: string,
  available: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): ToolNameResolution {
  if (available.includes(requested)) return { kind: 'resolved', toolName: requested };

  const aliased = resolveAlias(requested, aliases, available);
  if (aliased !== null) return { kind: 'resolved', toolName: aliased };

  const lower = requested.toLowerCase();
  const byCase = uniqueMatch(available, (name) => name.toLowerCase() === lower);
  if (byCase !== null) return { kind: 'resolved', toolName: byCase };

  const normalized = normalizeName(requested);
  const byShape = uniqueMatch(available, (name) => normalizeName(name) === normalized);
  if (byShape !== null) return { kind: 'resolved', toolName: byShape };

  return { kind: 'unknown', message: unknownToolMessage(requested, available) };
}

export function unknownToolMessage(requested: string, available: readonly string[]): string {
  const names = [...available].sort();
  const list = names.length > 0 ? names.join(', ') : '(none available)';
  return `unknown tool "${requested}". Available tools: ${list}. Call one of these exactly.`;
}

// Adapt `resolveToolName` to the AI SDK's `experimental_repairToolCall` hook: a fixable near-miss name
// is corrected in place; anything else yields null. On null the SDK surfaces NoSuchToolError — the
// caller catches it and renders `resolveToolName(...).message` so the model sees a structured result.
export function makeToolCallRepairer(
  init: ToolCallRepairInit = {},
): ToolCallRepairFunction<ToolSet> {
  const { aliases } = init;
  return async ({ toolCall, tools }) => {
    const resolution = resolveToolName(toolCall.toolName, Object.keys(tools), aliases);
    if (resolution.kind === 'resolved' && resolution.toolName !== toolCall.toolName) {
      return { ...toolCall, toolName: resolution.toolName };
    }
    return null;
  };
}

function resolveAlias(
  requested: string,
  aliases: Readonly<Record<string, string>>,
  available: readonly string[],
): string | null {
  const direct = aliases[requested];
  if (direct !== undefined && available.includes(direct)) return direct;
  const lower = requested.toLowerCase();
  for (const key of Object.keys(aliases)) {
    if (key.toLowerCase() !== lower) continue;
    const target = aliases[key];
    if (target !== undefined && available.includes(target)) return target;
  }
  return null;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

// The single name matching `predicate`, or null if none or more than one match (ambiguous → never guess).
function uniqueMatch(
  available: readonly string[],
  predicate: (name: string) => boolean,
): string | null {
  let found: string | null = null;
  for (const name of available) {
    if (!predicate(name)) continue;
    if (found !== null) return null;
    found = name;
  }
  return found;
}

// ── Model-output helpers ────────────────────────────────────────────────────────────────────────
// Local copies (kept per-module by the sibling decorators too): a shared helper would drag
// system-reminder/step-output-budget into this task's diff for no runtime gain.

// The base rendering the SDK would produce for a successful result: the tool's own `toModelOutput` if
// present, else text-for-string / json-otherwise (mirrors the SDK's createToolModelOutput default).
async function baseModelOutput(tool: Tool, ctx: ModelOutputCtx): Promise<ToolResultOutput> {
  if (tool.toModelOutput) return await tool.toModelOutput(ctx);
  return typeof ctx.output === 'string'
    ? { type: 'text', value: ctx.output }
    : { type: 'json', value: (ctx.output ?? null) as JsonToolValue };
}

// Put the reminder envelope BEFORE the base output so the model reads the warning first. Text stays
// text; any other base becomes the `content` variant with the envelope as the leading text part.
function prependReminder(base: ToolResultOutput, message: string): ToolResultOutput {
  const envelope = wrapReminder(message);
  if (base.type === 'text') {
    return { type: 'text', value: [envelope, base.value].join('\n') };
  }
  const baseParts =
    base.type === 'content'
      ? base.value
      : [{ type: 'text' as const, text: nonContentBaseAsText(base) }];
  return { type: 'content', value: [{ type: 'text' as const, text: envelope }, ...baseParts] };
}

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
      // Compile-time exhaustiveness: a new `ai` variant makes `base` non-`never` → a type error, not a
      // silent drop. Runtime stays fail-open (empty string) if one ever slips through.
      base satisfies never;
      return '';
  }
}

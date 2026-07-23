// Drives context compaction for long-running agent loops. Keeps the orchestrator and
// each subagent coherent on huge PRs by summarizing chat history when usage crosses
// a fraction of the model's context window.
//
// Strategy:
//   1. Pull contextLength for the active model from ModelLimitsRegistry.
//   2. Size the live context: prefer the provider-reported prompt tokens of the most recent call
//      (they count the system prompt + tool schemas a char estimate can't see), char-estimating only
//      the delta appended since; fall back to a whole-array char estimate when no usage is reported,
//      and never fall below it so a post-compaction under-report can't skip a needed compaction. See
//      effectiveInputTokens.
//   3. When size >= the USABLE budget, invoke a `fast`-tier summarization step that rewrites the
//      early conversation into a compact note; the next step resumes with the summary + the most
//      recent N steps verbatim. Usable is the window minus a reserve for the model's own reply
//      (see usableInputTokens) — not a flat fraction of it, which either wastes a large window or
//      overflows a small one. Mirrors opencode's session/overflow.ts.
//
// SDK references:
//   docs/vendor/ai-sdk/chunk-09.md §"Subagents" §"Controlling What the Model Sees"
//     (toModelOutput is the per-tool version of the same idea)
//   docs/vendor/ai-sdk/chunk-09.md §"Loop Control" §"Prepare Step"
//     (use prepareStep to swap in compacted messages between steps)

import { callWithStepTimeout } from '@developerz.ai/ai-claude-compat';
import { generateText, type LanguageModel, type TimeoutConfiguration } from 'ai';
import type { ModelLimitsLookup } from '../openrouter/model-limits.ts';

export type CompactionDecision =
  | { kind: 'skip' }
  // contextLength is carried so the wiring can log it per compaction without a second lookup.
  | { kind: 'compact'; keepLastSteps: number; contextLength: number };

// The live context size fed to shouldCompact. `estimatedInputTokens` — a ~4-char/token estimate over
// the live message array — is always present: the basis when the provider reported no usable usage,
// and the safety floor when it did. `reported`, present once a step has reported usage, carries the
// exact prompt tokens the provider billed for the most recent call plus a char estimate of the
// messages appended since that call; it is preferred because the provider count includes the system
// prompt and tool schemas the message-only estimate can't see.
export type LiveContextSize = {
  estimatedInputTokens: number;
  reported?: {
    lastCallInputTokens: number;
    sinceTokens: number;
  };
};

export type CompactionInit = {
  // The "fast" tier model used to write the summary. See src/credentials/defaults.ts.
  summarizer: LanguageModel;
  limits: ModelLimitsLookup;
  // Override the reply reserve (tokens held free for the model's own output). Unset → derived from
  // the model's published max output, capped at RESERVE_CEILING. See usableInputTokens.
  reserveTokens?: number;
  // How many of the most-recent steps to keep verbatim after compacting older history.
  keepLastSteps?: number; // default 6
  // Per-step LLM request deadline for the summarizer call (issue #129). Unset → no deadline. On
  // expiry the SDK aborts; callWithStepTimeout surfaces a named StepTimeoutError to the prepareStep
  // caller rather than hanging the step.
  timeout?: TimeoutConfiguration;
};

// Ceiling on the reply reserve. Input and output share the window, so some of it must stay free —
// but reserving a reasoning model's full 64k output budget on every step would strand a third of a
// 200k window on a reply that is almost never that long. Cap the reserve here and take the model's
// published max when it is SMALLER (a model that can only emit 4k needs only 4k held back).
// Same shape as opencode's COMPACTION_BUFFER.
const RESERVE_CEILING = 20_000;

// The share of the window that can actually hold conversation: everything except the reply reserve.
// Returns 0 for a window smaller than its own reserve — a model that cannot fit a reply plus any
// history at all, where compaction cannot help.
export function usableInputTokens(
  contextLength: number,
  maxOutputTokens: number | undefined,
  reserveOverride?: number,
): number {
  const reserve =
    reserveOverride ??
    (maxOutputTokens === undefined ? RESERVE_CEILING : Math.min(RESERVE_CEILING, maxOutputTokens));
  return Math.max(0, contextLength - reserve);
}
const DEFAULT_KEEP_LAST_STEPS = 6;

const SUMMARY_INSTRUCTIONS = [
  'You are a context-compaction summarizer for an autonomous coding agent.',
  'Rewrite the conversation prefix below as a tight bulleted note that preserves:',
  '- the goal and any acceptance criteria',
  '- decisions made, files touched, and commands run',
  '- open questions, blockers, and what to try next',
  'Drop greetings, restatements, and tool boilerplate. No prose, bullets only.',
  'Conversation (JSON):',
].join('\n');

// Anchored update-in-place: when a prior summary exists we hand it back verbatim and ask the model to
// fold newer work into fixed sections rather than re-summarizing from scratch. Fixed sections keep the
// summary stable across successive compactions (opencode's anchored-update template) instead of
// letting its shape and emphasis drift each round.
const ANCHORED_UPDATE_INSTRUCTIONS = [
  'You are a context-compaction summarizer for an autonomous coding agent.',
  'A prior summary of this task exists in <previous-summary>. UPDATE it in place with what the newer',
  'conversation below adds — do not restart from scratch and do not drop still-relevant facts. Move',
  'finished work into Done, refresh In progress, and accumulate Files touched. Keep it a tight',
  'bulleted note under these exact sections, no prose:',
  '- Objective: the goal and acceptance criteria (carry forward unless newly clarified)',
  '- Done: completed decisions, edits, and commands',
  '- In progress: what is being worked on right now',
  '- Files: files created or modified',
  '- Next: open questions, blockers, and what to try next',
].join('\n');

// The token count the trigger compares against the context window. Prefer the provider-reported
// prompt tokens of the most recent call (+ the char-estimated delta appended since): a char estimate
// over messages alone omits the system prompt and tool schemas, so it under-counts and compacts too
// late. But never fall BELOW the char estimate — the installed ai does not persist a prepareStep
// `messages` override across steps, so the step right after a compaction reports the small compacted
// call's input while the live array has reverted to the full history; trusting that small reported
// figure would skip compaction and let the window overflow (see compaction-step.ts, "Size off the
// LIVE messages"). Flooring by the estimate keeps that case safe. No reported usage → the estimate.
export function effectiveInputTokens(live: LiveContextSize): number {
  if (live.reported === undefined) return live.estimatedInputTokens;
  const grounded = live.reported.lastCallInputTokens + live.reported.sinceTokens;
  return Math.max(grounded, live.estimatedInputTokens);
}

export class Compactor {
  constructor(private readonly init: CompactionInit) {}

  async shouldCompact(modelId: string, live: LiveContextSize): Promise<CompactionDecision> {
    const { contextLength, maxOutputTokens } = await this.init.limits.forModel(modelId);
    // An absent, non-finite, or non-positive window would make ratio NaN/Infinity and force a
    // wrong decision. Treat it as "we don't know enough to compact" — skip. Absent is the real case
    // on an OpenAI-compatible catalog that publishes no context window (see contextLengthOf).
    if (contextLength === undefined || !Number.isFinite(contextLength) || contextLength <= 0) {
      return { kind: 'skip' };
    }
    const liveInputTokens = effectiveInputTokens(live);
    if (!Number.isFinite(liveInputTokens) || liveInputTokens < 0) {
      return { kind: 'skip' };
    }
    const usable = usableInputTokens(contextLength, maxOutputTokens, this.init.reserveTokens);
    // A window at or below its own reserve leaves nothing to compact INTO — summarizing would not
    // bring the conversation under the budget, so skip rather than burn a summarizer call per step.
    if (usable <= 0) {
      return { kind: 'skip' };
    }
    if (liveInputTokens >= usable) {
      return {
        kind: 'compact',
        keepLastSteps: this.init.keepLastSteps ?? DEFAULT_KEEP_LAST_STEPS,
        contextLength,
      };
    }
    return { kind: 'skip' };
  }

  // Produce a compact summary suitable for replacing the older conversation prefix. Pass
  // `priorSummary` (the text of an earlier compaction's SUMMARY_HEADER block) to UPDATE that anchor
  // in place — folding newer work into fixed sections (objective/done/in-progress/files/next) rather
  // than re-summarizing from scratch — so the note stays stable across successive compactions instead
  // of drifting each round. A blank/whitespace prior summary is treated as none (fresh summary).
  // Returns `undefined` when the summarizer produced empty/whitespace-only text — a blank
  // summary would otherwise replace real history with nothing, so the caller must treat this
  // as "leave the messages uncompacted" rather than substitute an empty note.
  async compact(
    olderMessages: ReadonlyArray<unknown>,
    priorSummary?: string,
  ): Promise<string | undefined> {
    const anchor = priorSummary?.trim() ?? '';
    const serialized = safeStringify(olderMessages);
    const prompt =
      anchor.length > 0
        ? [
            ANCHORED_UPDATE_INSTRUCTIONS,
            '<previous-summary>',
            anchor,
            '</previous-summary>',
            'Newer conversation to fold in (JSON):',
            serialized,
          ].join('\n')
        : `${SUMMARY_INSTRUCTIONS}\n${serialized}`;
    const { text } = await callWithStepTimeout(
      () =>
        generateText({
          model: this.init.summarizer,
          prompt,
          ...(this.init.timeout !== undefined ? { timeout: this.init.timeout } : {}),
        }),
      this.init.timeout,
    );
    const summary = text.trim();
    return summary.length === 0 ? undefined : summary;
  }
}

// Cycle-safe JSON.stringify. SDK message objects can transitively reference each other
// (tool result -> tool call -> step -> message), and a single circular ref would throw a
// raw TypeError out of compact() and crash the agent loop mid-step. Replace any cycle
// with the literal "[CYCLE]" so the summarizer still gets a usable transcript. Only TRUE
// cycles (a value that is its own ancestor) are replaced: the replacer tracks the ancestor
// chain via JSON.stringify's holder (`this`), because a grow-only seen-set would also mangle
// an object that merely appears twice (shared references are normal in SDK messages —
// issue #251, same family as the Logger.redact transcript corruption). Exported for unit testing.
export function safeStringify(value: unknown): string {
  const ancestors: unknown[] = [];
  return JSON.stringify(value, function (this: unknown, _key, v) {
    if (v !== null && typeof v === 'object') {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(v)) return '[CYCLE]';
      ancestors.push(v);
    }
    return v;
  });
}

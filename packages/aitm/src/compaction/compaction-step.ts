// Turns a Compactor into an AI SDK `prepareStep` hook (issue #102): between steps, when the live
// input-token count crosses the model's context-window threshold, first run a cheap prune stage
// (no model call) that clears the payloads of large, older tool results — keeping a recency shield
// of recent tool output and the kept-steps tail verbatim. Clearing stale, re-runnable output is
// often enough to fit the window; only when it isn't does the Compactor's LLM summarizer run,
// replacing the older prefix with a summary + the most recent steps verbatim, so a long
// Worker/Reviewer pass survives instead of dying on a context-window overflow. The Compactor holds
// the summarize policy; this module is the loop-wiring around it plus the prune pass.
//
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Loop Control" §"Prepare Step".

import type { ModelMessage, ToolLoopAgentSettings, ToolSet } from 'ai';
import type { LoggerLike } from '../logger/logger.ts';
import { reportedInputTokens } from '../observability/usage-tracker.ts';
import { type Compactor, effectiveInputTokens, type LiveContextSize } from './compactor.ts';

// The concrete (non-optional) prepareStep function type for a given tool set — extracted from the
// SDK's own settings so it matches createSubagent's field exactly (see the note in subagent.ts on
// why we can't write PrepareStepFunction<TOOLS> under exactOptionalPropertyTypes).
type CompactionPrepareStep<TOOLS extends ToolSet> = NonNullable<
  ToolLoopAgentSettings<never, TOOLS>['prepareStep']
>;

// Narrow port over the two Compactor methods this step calls, so tests/stubs can satisfy it
// structurally (Compactor is a class with private state; a plain object can't otherwise match it,
// and the repo forbids `as unknown as`). The real Compactor satisfies it.
export type CompactorLike = Pick<Compactor, 'shouldCompact' | 'compact'>;

export type CompactionStepInit = {
  compactor: CompactorLike;
  // The resolved model id whose context window governs the threshold (from Credentials.modelIdFor).
  modelId: string;
  // Optional structured logger — one event per compaction. Mirrors the other loop seams.
  logger?: LoggerLike;
};

// Prefix on the synthetic summary message so the model recognizes a compaction happened and honors
// the continuation contract in its system prompt (WORKER_SYSTEM_PREFIX / REVIEWER_SYSTEM_PREFIX).
const SUMMARY_HEADER =
  'Earlier conversation was summarized to fit the context window. Continue the task from this summary — do not wrap up early or re-plan from scratch.';

// Prune policy for the cheap pre-summarize pass. Values are conservative on purpose: rewriting the
// prefix costs a one-time prompt-cache miss (slice 04's stable-prefix work), so we only clear output
// that is both large and well past the working set, and compaction stays rare.
// - MIN_RESULT: results at/under this many chars aren't worth clearing (the placeholder has a cost).
// - SHIELD: keep this many chars of the most-recent tool output in the prunable region untouched.
// - FREED_THRESHOLD: if a prune frees at least this many chars, skip the LLM summarize entirely.
const PRUNE_PLACEHOLDER = '[old tool result cleared — rerun the tool if needed]';
const PRUNE_MIN_RESULT_CHARS = 1_000;
const PRUNE_SHIELD_CHARS = 40_000;
const PRUNE_FREED_THRESHOLD = 20_000;

// `ai` does not re-export `ToolResultOutput`; derive it from the public `ModelMessage` surface (same
// approach as ai-claude-compat/src/tool-guards.ts) so this keeps compiling if the SDK adds variants.
type ToolResultOutput = Extract<
  Extract<ModelMessage, { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>['output'];

// Build a `prepareStep` that compacts context when it crosses the threshold. Never throws: a lookup
// miss (ModelNotFound) or a summarizer error logs a warning and passes the messages through
// uncompacted, so compaction failure can never crash the step.
export function buildCompactionStep<TOOLS extends ToolSet = ToolSet>(
  init: CompactionStepInit,
): CompactionPrepareStep<TOOLS> {
  // The summary produced by the previous compaction in this run, threaded back into compact() so a
  // repeat compaction UPDATES that anchor in place (Compactor's anchored-update path) instead of
  // re-summarizing from scratch and letting the note drift. A closure var, not a scan of `older`: the
  // prepareStep `messages` override does not persist across steps (see the sizing note below), so the
  // earlier SUMMARY_HEADER block never reappears in the live history to recover.
  let priorSummary: string | undefined;
  return async ({ steps, messages }) => {
    // Nothing to send yet → nothing to compact.
    if (messages.length === 0) return undefined;

    // Cumulative response-message count at step `index` (ai@6 exposes step.response.messages as the
    // running total up to that step, not a per-step delta). Feeds both the usage delta below and the
    // kept-steps tail cut further down.
    const cumulativeAt = (index: number): number =>
      index >= 0 ? (steps[index]?.response.messages.length ?? 0) : 0;
    const last = steps.length - 1;

    // Size the live context, preferring the provider's exact prompt-token count for the most recent
    // call (system prompt + tool schemas included) over a pure char estimate, and char-estimating only
    // the delta the last step appended since that call. No completed step / no reported usage → the
    // whole-array estimate. shouldCompact floors the grounded figure by this estimate, so a
    // post-compaction under-report can't skip a needed compaction: the installed ai does not persist a
    // prepareStep `messages` override across steps, so the step after a compaction reports the small
    // compacted call while `messages` has reverted to the full history — the estimate re-detects that
    // and re-compacts, keeping every step's call bounded. (A cached-summary optimization is a follow-up.)
    const estimatedInputTokens = estimateTokens(messages);
    const reported = reportedInputTokens(steps[last]?.usage);
    const sinceLastCall = cumulativeAt(last) - cumulativeAt(last - 1);
    const live: LiveContextSize =
      reported === undefined
        ? { estimatedInputTokens }
        : {
            estimatedInputTokens,
            reported: {
              lastCallInputTokens: reported,
              sinceTokens: estimateTokens(messagesSince(messages, sinceLastCall)),
            },
          };
    const liveInputTokens = effectiveInputTokens(live);

    let decision: Awaited<ReturnType<Compactor['shouldCompact']>>;
    try {
      decision = await init.compactor.shouldCompact(init.modelId, live);
    } catch (err) {
      init.logger?.warn('compaction: threshold lookup failed; passing through', {
        modelId: init.modelId,
        error: errText(err),
      });
      return undefined;
    }
    if (decision.kind === 'skip') return undefined;

    // No completed steps yet — the first prepareStep of a run, or of a #107 `priorHandle`
    // continuation. There is no step boundary to cut, and a continuation's live tail must not be
    // summarized away (cumulative math below would treat the whole injected history as `older`).
    // Pass through; compaction resumes once a step has run.
    if (steps.length === 0) return undefined;

    // Cut at a step boundary: keep the response messages of the last keepLastSteps steps verbatim, so
    // an assistant tool-call and its tool-result (same step) are never split. `ai@6` exposes
    // `step.response.messages` as the CUMULATIVE response list up to that step, not a per-step delta
    // (verified against a live run: per-step lengths [2, 4, 6]). So the last-K-steps message count is
    // the final cumulative total minus the cumulative total keepLastSteps steps earlier — NOT the sum
    // of those arrays, which overcounts so far that `splitAt` pins to 0 and compaction never fires
    // (issue #176).
    const tailCount = cumulativeAt(last) - cumulativeAt(last - decision.keepLastSteps);
    const splitAt = Math.max(0, messages.length - tailCount);
    const older = messages.slice(0, splitAt);
    const tail = messages.slice(splitAt);
    // Nothing older than the kept tail → summarizing would drop nothing; pass through.
    if (older.length === 0) return undefined;

    // Cheap prune stage first (no model call): clear the payloads of large, older tool results,
    // keeping a recency shield of recent tool output and the kept-steps tail verbatim. Stale results
    // (a `git status` from 40 steps ago, a file re-read since) are the bulk of a bloated window and
    // are re-runnable, so clearing them often reclaims enough context that the LLM summarize never
    // has to run. Only when it frees too little do we fall through to the summarizer below.
    const pruned = pruneOldToolResults(messages, splitAt);
    if (pruned.freedChars >= PRUNE_FREED_THRESHOLD) {
      init.logger?.info('compaction: pruned stale tool results (no summarize)', {
        modelId: init.modelId,
        liveInputTokens,
        freedChars: pruned.freedChars,
        clearedResults: pruned.clearedResults,
      });
      return { messages: pruned.messages };
    }

    let summary: string | undefined;
    try {
      // Summarize the PRUNED older prefix: results the prune pass cleared are already gone, so the
      // summarizer neither re-reads their bulk nor re-describes soon-to-be-cleared output. Thread the
      // prior summary so a repeat compaction updates that anchor in place rather than drifting.
      summary = await init.compactor.compact(pruned.messages.slice(0, splitAt), priorSummary);
    } catch (err) {
      init.logger?.warn('compaction: summarizer failed; passing through', {
        modelId: init.modelId,
        error: errText(err),
      });
      return undefined;
    }

    // Empty/whitespace summary → the summarizer produced nothing usable. Passing through
    // uncompacted is safer than replacing real history with a blank note (issue: empty-summary
    // context loss).
    if (summary === undefined) {
      init.logger?.warn('compaction: summarizer returned empty text; passing through', {
        modelId: init.modelId,
      });
      return undefined;
    }

    // Anchor the next compaction in this run to this summary so it updates in place, not from scratch.
    priorSummary = summary;

    init.logger?.info('compaction: compacted context', {
      modelId: init.modelId,
      liveInputTokens,
      contextLength: decision.contextLength,
      keptSteps: decision.keepLastSteps,
      prunedChars: pruned.freedChars,
    });

    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `${SUMMARY_HEADER}\n\n${summary}`,
    };
    return { messages: [summaryMessage, ...tail] };
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Rough token estimate of the message array — ~4 chars per token over the serialized content. It
// over-counts JSON structure slightly, which only makes compaction trigger a touch early; for a
// context-overflow guardrail, erring toward compacting sooner is the safe direction.
function estimateTokens(messages: readonly ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars +=
      typeof message.content === 'string'
        ? message.content.length
        : JSON.stringify(message.content).length;
  }
  return Math.ceil(chars / 4);
}

// The messages the last step appended since its own model call — the tail `delta` entries of the live
// array (ai@6 appends each step's response messages in order). These are exactly what the provider's
// last-call token count does NOT yet include, so the usage-grounded trigger char-estimates only them
// and adds them to that count. A non-positive delta (no completed step) → nothing.
function messagesSince(messages: readonly ModelMessage[], delta: number): readonly ModelMessage[] {
  return delta > 0 ? messages.slice(Math.max(0, messages.length - delta)) : [];
}

// Cheap, model-free prune pass over the prunable prefix (`messages[0, splitAt)` — everything older
// than the kept-steps tail). Walks newest → oldest so a recency shield preserves the most-recent
// `shieldChars` of tool output; older tool results larger than `minResultChars` have their payload
// replaced with a short placeholder, keeping the tool-call/result pairing (and thus a message array
// the API still accepts) intact. Returns a fresh array — the input is never mutated. `freedChars` is
// the net chars reclaimed, which the caller compares against its skip-summarize threshold.
export function pruneOldToolResults(
  messages: readonly ModelMessage[],
  splitAt: number,
  opts: { shieldChars?: number; minResultChars?: number } = {},
): { messages: ModelMessage[]; freedChars: number; clearedResults: number } {
  const shieldChars = opts.shieldChars ?? PRUNE_SHIELD_CHARS;
  const minResultChars = opts.minResultChars ?? PRUNE_MIN_RESULT_CHARS;
  const out: ModelMessage[] = [...messages];
  let shieldUsed = 0;
  let freedChars = 0;
  let clearedResults = 0;

  for (let i = Math.min(splitAt, messages.length) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== 'tool' || !Array.isArray(message.content)) {
      continue;
    }
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const size = outputCharSize(part.output);
      // Keep small results (not worth clearing) and anything still inside the recency shield; both
      // consume the shield budget so it fills from the most-recent output first.
      if (size <= minResultChars || shieldUsed < shieldChars) {
        shieldUsed += size;
        return part;
      }
      changed = true;
      freedChars += size - PRUNE_PLACEHOLDER.length;
      clearedResults += 1;
      const cleared: ToolResultOutput = { type: 'text', value: PRUNE_PLACEHOLDER };
      return { ...part, output: cleared };
    });
    if (changed) out[i] = { ...message, content };
  }

  return { messages: out, freedChars, clearedResults };
}

// Char size of a tool result's payload — the text the model actually reads, so the prune thresholds
// compare against real context cost. Falls back to a JSON length for shapes without a plain string
// value (and for any output variant a future `ai` adds), never throwing.
function outputCharSize(output: ToolResultOutput): number {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value.length;
    case 'json':
    case 'error-json':
    case 'content':
      return jsonLength(output.value);
    default:
      return jsonLength(output);
  }
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

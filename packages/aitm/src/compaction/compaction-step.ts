// Turns a Compactor into an AI SDK `prepareStep` hook (issue #102): between steps, when the live
// input-token count crosses the model's context-window threshold, replace the message array with a
// summary of the older prefix + the most recent steps verbatim, so a long Worker/Reviewer pass
// survives instead of dying on a context-window overflow. The Compactor holds the policy; this is
// the thin loop-wiring around it.
//
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Loop Control" §"Prepare Step".

import type { ModelMessage, ToolLoopAgentSettings, ToolSet } from 'ai';
import type { LoggerLike } from '../logger/logger.ts';
import type { Compactor } from './compactor.ts';

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

// Build a `prepareStep` that compacts context when it crosses the threshold. Never throws: a lookup
// miss (ModelNotFound) or a summarizer error logs a warning and passes the messages through
// uncompacted, so compaction failure can never crash the step.
export function buildCompactionStep<TOOLS extends ToolSet = ToolSet>(
  init: CompactionStepInit,
): CompactionPrepareStep<TOOLS> {
  return async ({ steps, messages }) => {
    // Nothing to send yet → nothing to compact.
    if (messages.length === 0) return undefined;

    // Size off the LIVE `messages` (the context this step will actually send), NOT the last step's
    // usage. The installed ai does not persist a prepareStep `messages` override across steps — the
    // override applies to the current step only, then the loop reverts to the full accumulated
    // history on the next step. So after a compaction, the last step's usage reflects the small
    // compacted call while `messages` reverts to the full history; sizing off usage would then read
    // "small", skip, and let the full context overflow. Sizing off `messages` re-detects the large
    // context each step and re-compacts, keeping every step's call bounded regardless of whether the
    // SDK persists overrides. (A persistence-aware / cached-summary optimization is a follow-up.)
    const liveInputTokens = estimateTokens(messages);

    let decision: Awaited<ReturnType<Compactor['shouldCompact']>>;
    try {
      decision = await init.compactor.shouldCompact(init.modelId, liveInputTokens);
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
    const cumulativeAt = (index: number): number =>
      index >= 0 ? (steps[index]?.response.messages.length ?? 0) : 0;
    const last = steps.length - 1;
    const tailCount = cumulativeAt(last) - cumulativeAt(last - decision.keepLastSteps);
    const splitAt = Math.max(0, messages.length - tailCount);
    const older = messages.slice(0, splitAt);
    const tail = messages.slice(splitAt);
    // Nothing older than the kept tail → summarizing would drop nothing; pass through.
    if (older.length === 0) return undefined;

    let summary: string;
    try {
      summary = await init.compactor.compact(older);
    } catch (err) {
      init.logger?.warn('compaction: summarizer failed; passing through', {
        modelId: init.modelId,
        error: errText(err),
      });
      return undefined;
    }

    init.logger?.info('compaction: compacted context', {
      modelId: init.modelId,
      liveInputTokens,
      contextLength: decision.contextLength,
      keptSteps: decision.keepLastSteps,
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

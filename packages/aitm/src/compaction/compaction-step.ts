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

export type CompactionStepInit = {
  compactor: Compactor;
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
// miss (ModelNotFound), missing usage, or a summarizer error logs a warning and passes the messages
// through uncompacted, so compaction failure can never crash the step.
export function buildCompactionStep<TOOLS extends ToolSet = ToolSet>(
  init: CompactionStepInit,
): CompactionPrepareStep<TOOLS> {
  return async ({ steps, messages }) => {
    // Live context size = the running input-token total the model reported on the latest completed
    // step. On the first step (no steps yet, or usage absent) there is nothing to compact.
    const liveInputTokens = steps.at(-1)?.usage.inputTokens;
    if (liveInputTokens === undefined) return undefined;

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

    // Cut at a step boundary: keep the response messages of the last keepLastSteps steps verbatim,
    // so an assistant tool-call and its tool-result (which live in the same step) are never split.
    const tailCount = steps
      .slice(-decision.keepLastSteps)
      .reduce((n, step) => n + step.response.messages.length, 0);
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

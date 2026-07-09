// Drives context compaction for long-running agent loops. Keeps the orchestrator and
// each subagent coherent on huge PRs by summarizing chat history when usage crosses
// a fraction of the model's context window.
//
// Strategy:
//   1. Pull contextLength for the active model from ModelLimitsRegistry.
//   2. Estimate live token usage from the agent's step.usage.inputTokens running total.
//   3. When usage / contextLength >= threshold (default 0.7), invoke a `fast`-tier
//      summarization step that rewrites the early conversation into a compact note;
//      the next step resumes with the summary + the most recent N steps verbatim.
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

export type CompactionInit = {
  // The "fast" tier model used to write the summary. See src/credentials/defaults.ts.
  summarizer: LanguageModel;
  limits: ModelLimitsLookup;
  // Compact when usage / contextLength crosses this fraction.
  threshold?: number; // default 0.7
  // How many of the most-recent steps to keep verbatim after compacting older history.
  keepLastSteps?: number; // default 6
  // Per-step LLM request deadline for the summarizer call (issue #129). Unset → no deadline. On
  // expiry the SDK aborts; callWithStepTimeout surfaces a named StepTimeoutError to the prepareStep
  // caller rather than hanging the step.
  timeout?: TimeoutConfiguration;
};

const DEFAULT_THRESHOLD = 0.7;
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

export class Compactor {
  constructor(private readonly init: CompactionInit) {}

  async shouldCompact(modelId: string, liveInputTokens: number): Promise<CompactionDecision> {
    const { contextLength } = await this.init.limits.forModel(modelId);
    // A non-finite or non-positive window would make ratio NaN/Infinity and force a
    // wrong decision. Treat it as "we don't know enough to compact" — skip.
    if (!Number.isFinite(contextLength) || contextLength <= 0) {
      return { kind: 'skip' };
    }
    if (!Number.isFinite(liveInputTokens) || liveInputTokens < 0) {
      return { kind: 'skip' };
    }
    const ratio = liveInputTokens / contextLength;
    const threshold = this.init.threshold ?? DEFAULT_THRESHOLD;
    if (ratio >= threshold) {
      return {
        kind: 'compact',
        keepLastSteps: this.init.keepLastSteps ?? DEFAULT_KEEP_LAST_STEPS,
        contextLength,
      };
    }
    return { kind: 'skip' };
  }

  // Produce a compact summary suitable for replacing the older conversation prefix.
  async compact(olderMessages: ReadonlyArray<unknown>): Promise<string> {
    const { text } = await callWithStepTimeout(
      () =>
        generateText({
          model: this.init.summarizer,
          prompt: `${SUMMARY_INSTRUCTIONS}\n${safeStringify(olderMessages)}`,
          ...(this.init.timeout !== undefined ? { timeout: this.init.timeout } : {}),
        }),
      this.init.timeout,
    );
    return text;
  }
}

// Cycle-safe JSON.stringify. SDK message objects can transitively reference each other
// (tool result -> tool call -> step -> message), and a single circular ref would throw a
// raw TypeError out of compact() and crash the agent loop mid-step. Replace any cycle
// with the literal "[CYCLE]" so the summarizer still gets a usable transcript.
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return '[CYCLE]';
      seen.add(v);
    }
    return v;
  });
}

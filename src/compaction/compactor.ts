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

import type { LanguageModel } from 'ai';
import type { ModelLimitsRegistry } from '../openrouter/model-limits.ts';

export type CompactionDecision = { kind: 'skip' } | { kind: 'compact'; keepLastSteps: number };

export type CompactionInit = {
  // The "fast" tier model used to write the summary. See src/credentials/defaults.ts.
  summarizer: LanguageModel;
  limits: ModelLimitsRegistry;
  // Compact when usage / contextLength crosses this fraction.
  threshold?: number; // default 0.7
  // How many of the most-recent steps to keep verbatim after compacting older history.
  keepLastSteps?: number; // default 6
};

export class Compactor {
  constructor(private readonly init: CompactionInit) {}

  async shouldCompact(_modelId: string, _liveInputTokens: number): Promise<CompactionDecision> {
    throw new Error('not implemented');
  }

  // Produce a compact summary suitable for replacing the older conversation prefix.
  async compact(_olderMessages: ReadonlyArray<unknown>): Promise<string> {
    throw new Error('not implemented');
  }
}

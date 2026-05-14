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

import { generateText, type LanguageModel } from 'ai';
import type { ModelLimitsLookup } from '../openrouter/model-limits.ts';

export type CompactionDecision = { kind: 'skip' } | { kind: 'compact'; keepLastSteps: number };

export type CompactionInit = {
  // The "fast" tier model used to write the summary. See src/credentials/defaults.ts.
  summarizer: LanguageModel;
  limits: ModelLimitsLookup;
  // Compact when usage / contextLength crosses this fraction.
  threshold?: number; // default 0.7
  // How many of the most-recent steps to keep verbatim after compacting older history.
  keepLastSteps?: number; // default 6
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
      return { kind: 'compact', keepLastSteps: this.init.keepLastSteps ?? DEFAULT_KEEP_LAST_STEPS };
    }
    return { kind: 'skip' };
  }

  // Produce a compact summary suitable for replacing the older conversation prefix.
  async compact(olderMessages: ReadonlyArray<unknown>): Promise<string> {
    const { text } = await generateText({
      model: this.init.summarizer,
      prompt: `${SUMMARY_INSTRUCTIONS}\n${JSON.stringify(olderMessages)}`,
    });
    return text;
  }
}

// Shared MockLanguageModelV3 fixtures (issue #132, surfaced on #133 + #134).
//
// `emptyUsage` was copy-pasted into six test files and `emptyManifestModel` into two. Every copy
// carried a `totalTokens` field the SDK's `LanguageModelV3Usage` does not have — six copies of one
// stale shape, which is how the suite accumulated the errors the `typecheck:tests` gate now catches.
//
// Types are DERIVED from `MockLanguageModelV3` rather than imported from `@ai-sdk/provider`: aitm
// does not depend on that package directly (it arrives transitively through `ai`), and deriving
// keeps these correct by construction when the result shape moves again — it already did once, from
// a bare `finishReason: 'stop'` string to `{ unified, raw }`.

import type { LanguageModelUsage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

export type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;
export type GenerateUsage = GenerateResult['usage'];

// Non-zero on purpose: several tests assert usage accumulates across steps, and an all-zero fixture
// would make a broken sum indistinguishable from a working one.
export function emptyUsage(): GenerateUsage {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
}

export function textResult(text: string, over: Partial<GenerateResult> = {}): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: emptyUsage(),
    warnings: [],
    ...over,
  };
}

// The terminal `submit` tool-call every aitm subagent uses for structured output since #54.
export function submitResult(input: unknown, over: Partial<GenerateResult> = {}): GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'submit-0',
        toolName: 'submit',
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: emptyUsage(),
    warnings: [],
    ...over,
  };
}

export function submittingModel(input: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doGenerate: async () => submitResult(input) });
}

// The "agent narrated but produced no edits" path driven by the blocked-delivery and CI-fix tests.
export function emptyManifestModel(): MockLanguageModelV3 {
  return submittingModel({ files: [] });
}

// The `ai`-level usage type (distinct from the provider-level `LanguageModelV3Usage` above): it
// carries required per-token-kind detail objects that call sites summing whole-run totals never set.
export function modelUsage(over: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    ...over,
  };
}

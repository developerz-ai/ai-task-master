// A typed `StepResult` test double (issue #132).
//
// `prepareStep` receives full `StepResult` objects — 24 fields — but aitm's compaction step reads
// exactly two of them: `response.messages` and `usage.inputTokens`. The compaction tests therefore
// passed `{ response: { messages } }` literals, which is honest about what is exercised and is also
// 33 of the suite's type errors.
//
// `stepResult` fills the other 22 fields with empty defaults so a caller states only what it cares
// about, and the object it gets back is the real type. If the SDK adds a required field, this
// factory fails to compile once instead of every call site failing separately.

import { MockLanguageModelV3 } from 'ai/test';
import type { buildCompactionStep } from '../compaction/compaction-step.ts';

type PrepareStepArg = Parameters<ReturnType<typeof buildCompactionStep>>[0];
export type Step = PrepareStepArg['steps'][number];

export function stepResult(over: Partial<Step> = {}): Step {
  return {
    stepNumber: 0,
    model: { provider: 'test', modelId: 'test-model' },
    functionId: undefined,
    metadata: undefined,
    experimental_context: undefined,
    content: [],
    text: '',
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: 'stop',
    rawFinishReason: undefined,
    usage: {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    },
    warnings: undefined,
    request: {},
    response: { id: 'res-0', modelId: 'test-model', timestamp: new Date(0), messages: [] },
    providerMetadata: undefined,
    ...over,
  };
}

// A step's `response` half. Overriding it on `stepResult` means restating the three envelope fields
// nothing reads, so they are stated here instead — `messages` is what a caller actually varies.
export function stepResponse(messages: Step['response']['messages']): Step['response'] {
  return { id: 'res-0', modelId: 'test-model', timestamp: new Date(0), messages };
}

/**
 * The `prepareStep` argument, built around `steps` + `messages` — the only two fields aitm's
 * compaction step branches on. `model` is a mock handle because the type demands one.
 */
export function prepareStepArg(
  steps: PrepareStepArg['steps'],
  messages: PrepareStepArg['messages'],
): PrepareStepArg {
  return {
    steps,
    stepNumber: steps.length,
    model: new MockLanguageModelV3(),
    messages,
    experimental_context: undefined,
  };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { ModelLimits, ModelLimitsLookup } from '../openrouter/model-limits.ts';
import { Compactor } from './compactor.ts';

function stubLimits(contextLength: number, modelId = 'openai/gpt-5'): ModelLimitsLookup {
  return {
    forModel: async (id: string): Promise<ModelLimits> => ({ modelId: id, contextLength }),
    preload: async () => {},
  } satisfies ModelLimitsLookup;
}

function summarizerReturning(text: string): {
  model: MockLanguageModelV3;
  callPrompts: () => string[];
} {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      // Capture the rendered user prompt for assertions.
      const userMessages = options.prompt.filter((m) => m.role === 'user');
      const last = userMessages[userMessages.length - 1];
      if (last && last.role === 'user') {
        const parts = Array.isArray(last.content) ? last.content : [];
        for (const part of parts) {
          if (part.type === 'text') prompts.push(part.text);
        }
      }
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  return { model, callPrompts: () => prompts };
}

test('Compactor is constructible', () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
  });
  assert.ok(c instanceof Compactor);
});

test('shouldCompact returns skip just below the 0.7 default threshold', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
  });
  const decision = await c.shouldCompact('openai/gpt-5', 69_999);
  assert.deepEqual(decision, { kind: 'skip' });
});

test('shouldCompact returns compact at exactly the 0.7 default threshold', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
  });
  const decision = await c.shouldCompact('openai/gpt-5', 70_000);
  assert.deepEqual(decision, { kind: 'compact', keepLastSteps: 6 });
});

test('shouldCompact returns compact above the threshold and carries keepLastSteps override', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
    keepLastSteps: 3,
  });
  const decision = await c.shouldCompact('openai/gpt-5', 99_999);
  assert.deepEqual(decision, { kind: 'compact', keepLastSteps: 3 });
});

test('shouldCompact skips when contextLength is zero, negative, or non-finite', async () => {
  for (const contextLength of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const c = new Compactor({
      summarizer: new MockLanguageModelV3(),
      limits: stubLimits(contextLength),
    });
    assert.deepEqual(await c.shouldCompact('openai/gpt-5', 1_000_000), { kind: 'skip' });
  }
});

test('shouldCompact honors a custom threshold', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
    threshold: 0.5,
  });
  assert.deepEqual(await c.shouldCompact('openai/gpt-5', 49_999), { kind: 'skip' });
  assert.deepEqual(await c.shouldCompact('openai/gpt-5', 50_000), {
    kind: 'compact',
    keepLastSteps: 6,
  });
});

test('compact returns the summarizer text and embeds the JSON of older messages', async () => {
  const { model, callPrompts } = summarizerReturning('- did X\n- decided Y');
  const c = new Compactor({ summarizer: model, limits: stubLimits(100_000) });
  const older = [
    { role: 'user', content: 'Goal: refactor parser' },
    { role: 'assistant', content: 'Plan: split into lexer + parser' },
  ];
  const summary = await c.compact(older);
  assert.equal(summary, '- did X\n- decided Y');

  const prompts = callPrompts();
  assert.equal(prompts.length, 1);
  const sent = prompts[0] ?? '';
  assert.match(sent, /bulleted note/);
  assert.ok(sent.includes(JSON.stringify(older)), 'prompt must embed JSON of older messages');
});

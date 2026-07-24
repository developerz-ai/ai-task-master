import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageModelUsage } from 'ai';
import { reportUsage } from './usage-sink.ts';

test('reportUsage forwards usage + modelId, and swallows a throwing sink (issue #114)', () => {
  const result = {
    totalUsage: { inputTokens: 10, outputTokens: 2 } as LanguageModelUsage,
    response: { modelId: 'anthropic/opus' },
  };
  const seen: Array<{ usage: LanguageModelUsage; modelId: string | undefined }> = [];
  reportUsage((usage, modelId) => seen.push({ usage, modelId }), result);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.modelId, 'anthropic/opus');
  assert.equal(seen[0]?.usage.inputTokens, 10);
  // A throwing sink must never propagate — observability can't break a run.
  assert.doesNotThrow(() =>
    reportUsage(() => {
      throw new Error('sink boom');
    }, result),
  );
  // No sink → no-op.
  assert.doesNotThrow(() => reportUsage(undefined, result));
});

test('reportUsage forwards providerMetadata when present, undefined when absent (slice 04b)', () => {
  const withMeta = {
    totalUsage: { inputTokens: 10, outputTokens: 2 } as LanguageModelUsage,
    response: { modelId: 'anthropic/opus' },
    providerMetadata: { openrouter: { usage: { cacheDiscount: 0.001 } } },
  };
  const seen: unknown[] = [];
  reportUsage((_usage, _modelId, providerMetadata) => seen.push(providerMetadata), withMeta);
  assert.deepEqual(seen[0], { openrouter: { usage: { cacheDiscount: 0.001 } } });

  const withoutMeta = {
    totalUsage: { inputTokens: 10, outputTokens: 2 } as LanguageModelUsage,
    response: { modelId: 'anthropic/opus' },
  };
  reportUsage((_usage, _modelId, providerMetadata) => seen.push(providerMetadata), withoutMeta);
  assert.equal(seen[1], undefined);
});

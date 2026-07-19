import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageModelUsage } from 'ai';
import {
  appendReminderBlock,
  DEFAULT_LLM_STEP_TIMEOUT_MS,
  prependContextBlock,
  reportUsage,
  type SubagentFactory,
  type SubagentInit,
} from './factory.ts';

test('SubagentInit / SubagentFactory types are exported (compile-time check)', () => {
  // The body is only here so the import is preserved through ts-strip / bundlers.
  const _t: SubagentInit | undefined = undefined;
  const _f: SubagentFactory<unknown, unknown> | undefined = undefined;
  assert.equal(_t, undefined);
  assert.equal(_f, undefined);
});

test('DEFAULT_LLM_STEP_TIMEOUT_MS is 900_000 and clears the 600s bash ceiling (issue #129)', () => {
  assert.equal(DEFAULT_LLM_STEP_TIMEOUT_MS, 900_000);
  assert.ok(DEFAULT_LLM_STEP_TIMEOUT_MS > 600_000, 'must exceed MAX_BASH_TIMEOUT_MS');
});

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

test('prependContextBlock: prepends the block with a blank-line separator, or returns the prompt unchanged (issue #106)', () => {
  assert.equal(
    prependContextBlock('<system-reminder>\nctx\n</system-reminder>', 'Goal: x'),
    '<system-reminder>\nctx\n</system-reminder>\n\nGoal: x',
  );
  assert.equal(prependContextBlock(undefined, 'Goal: x'), 'Goal: x');
  assert.equal(prependContextBlock('', 'Goal: x'), 'Goal: x', 'empty block is a no-op');
});

test('appendReminderBlock: appends the trailing block with a blank-line separator, or returns the prompt unchanged (slice 04 §4)', () => {
  assert.equal(
    appendReminderBlock(
      'Goal: x',
      '<system-reminder>\n# runProgress\nStep 1 of 4\n</system-reminder>',
    ),
    'Goal: x\n\n<system-reminder>\n# runProgress\nStep 1 of 4\n</system-reminder>',
  );
  assert.equal(appendReminderBlock('Goal: x', undefined), 'Goal: x');
  assert.equal(appendReminderBlock('Goal: x', ''), 'Goal: x', 'empty block is a no-op');
});

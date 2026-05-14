import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelLimitsRegistry } from './model-limits.ts';

test('ModelLimitsRegistry is constructible (skeleton)', () => {
  const r = new ModelLimitsRegistry({} as never);
  assert.ok(r instanceof ModelLimitsRegistry);
});

test('ModelLimitsRegistry.forModel throws until implemented', async () => {
  const r = new ModelLimitsRegistry({} as never);
  await assert.rejects(() => r.forModel('anthropic/claude-opus-4.7'));
});

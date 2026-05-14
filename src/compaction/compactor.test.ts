import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Compactor } from './compactor.ts';

test('Compactor is constructible (skeleton)', () => {
  const c = new Compactor({
    summarizer: {} as never,
    limits: {} as never,
  });
  assert.ok(c instanceof Compactor);
});

test('Compactor.shouldCompact throws until implemented', async () => {
  const c = new Compactor({
    summarizer: {} as never,
    limits: {} as never,
  });
  await assert.rejects(() => c.shouldCompact('anthropic/claude-opus-4.7', 1000));
});

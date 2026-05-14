import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenRouterClient, OpenRouterModelSchema } from './client.ts';

test('OpenRouterClient is constructible (skeleton)', () => {
  const c = new OpenRouterClient('sk-or-test');
  assert.ok(c instanceof OpenRouterClient);
});

test('OpenRouterClient.listModels throws until implemented', async () => {
  const c = new OpenRouterClient('sk-or-test');
  await assert.rejects(() => c.listModels());
});

test('OpenRouterModelSchema validates the documented shape', () => {
  const parsed = OpenRouterModelSchema.parse({
    id: 'anthropic/claude-opus-4.7',
    context_length: 200_000,
    pricing: { prompt: '0.000015', completion: '0.000075' },
  });
  assert.equal(parsed.context_length, 200_000);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenRouterClient, OpenRouterModel } from './client.ts';
import { ModelLimitsRegistry, ModelNotFound } from './model-limits.ts';

type StubClient = Pick<OpenRouterClient, 'listModels'> & { calls: number };

function makeStub(models: OpenRouterModel[]): StubClient {
  const stub: StubClient = {
    calls: 0,
    listModels: async () => {
      stub.calls += 1;
      return models;
    },
  };
  return stub;
}

const opus: OpenRouterModel = {
  id: 'anthropic/claude-opus-4.7',
  context_length: 200_000,
};
const gpt5: OpenRouterModel = { id: 'openai/gpt-5', context_length: 128_000 };

test('ModelLimitsRegistry is constructible', () => {
  const r = new ModelLimitsRegistry({} as never);
  assert.ok(r instanceof ModelLimitsRegistry);
});

test('forModel returns context length from catalog', async () => {
  const stub = makeStub([opus, gpt5]);
  const r = new ModelLimitsRegistry(stub as unknown as OpenRouterClient);
  const limits = await r.forModel('openai/gpt-5');
  assert.equal(limits.modelId, 'openai/gpt-5');
  assert.equal(limits.contextLength, 128_000);
});

test('forModel caches across calls — listModels invoked once', async () => {
  const stub = makeStub([opus, gpt5]);
  const r = new ModelLimitsRegistry(stub as unknown as OpenRouterClient);
  await r.forModel('anthropic/claude-opus-4.7');
  await r.forModel('openai/gpt-5');
  await r.forModel('anthropic/claude-opus-4.7');
  assert.equal(stub.calls, 1);
});

test('preload populates cache and is idempotent', async () => {
  const stub = makeStub([opus]);
  const r = new ModelLimitsRegistry(stub as unknown as OpenRouterClient);
  await r.preload();
  await r.preload();
  assert.equal(stub.calls, 1);
  const limits = await r.forModel('anthropic/claude-opus-4.7');
  assert.equal(limits.contextLength, 200_000);
  assert.equal(stub.calls, 1);
});

test('preload parses per-token pricing incl. cache read/write; blank/missing → undefined (issue #114)', async () => {
  const priced: OpenRouterModel = {
    id: 'anthropic/opus',
    context_length: 200_000,
    pricing: {
      prompt: '0.000005',
      completion: '0.000015',
      input_cache_read: '0.0000005',
      input_cache_write: '0.00000625',
    },
  };
  const noPricing: OpenRouterModel = { id: 'x/y', context_length: 1000 };
  const r = new ModelLimitsRegistry(makeStub([priced, noPricing]) as unknown as OpenRouterClient);
  const p = await r.forModel('anthropic/opus');
  assert.equal(p.promptUsdPerToken, 5e-6);
  assert.equal(p.completionUsdPerToken, 1.5e-5);
  assert.equal(p.cacheReadUsdPerToken, 5e-7);
  assert.equal(p.cacheWriteUsdPerToken, 6.25e-6);
  // A model with no pricing block leaves every price field undefined (consumers degrade to null).
  const n = await r.forModel('x/y');
  assert.equal(n.promptUsdPerToken, undefined);
  assert.equal(n.cacheReadUsdPerToken, undefined);
});

test('preload treats blank/whitespace pricing strings as missing, not $0 (issue #114)', async () => {
  // `Number('')` is 0 in JS — a blank catalog field must degrade to undefined (unknown), not $0/token.
  const blank: OpenRouterModel = {
    id: 'blank/price',
    context_length: 1000,
    pricing: { prompt: '', completion: '   ' },
  };
  const r = new ModelLimitsRegistry(makeStub([blank]) as unknown as OpenRouterClient);
  const p = await r.forModel('blank/price');
  assert.equal(p.promptUsdPerToken, undefined, 'blank prompt → undefined, not 0');
  assert.equal(p.completionUsdPerToken, undefined, 'whitespace completion → undefined, not 0');
});

test('forModel throws ModelNotFound for unknown id', async () => {
  const stub = makeStub([opus]);
  const r = new ModelLimitsRegistry(stub as unknown as OpenRouterClient);
  await assert.rejects(
    () => r.forModel('mystery/model'),
    (err: unknown) => {
      assert.ok(err instanceof ModelNotFound);
      assert.equal(err.name, 'ModelNotFound');
      assert.equal(err.modelId, 'mystery/model');
      assert.match(err.message, /mystery\/model/);
      return true;
    },
  );
});

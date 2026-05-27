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

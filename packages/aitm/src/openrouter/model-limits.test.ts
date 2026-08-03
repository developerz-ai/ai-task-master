import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CatalogRow, catalogModel } from '../testing/domain-fixtures.ts';
import type { OpenRouterClient, OpenRouterModel } from './client.ts';
import { ModelLimitsRegistry, ModelNotFound } from './model-limits.ts';

type StubClient = Pick<OpenRouterClient, 'listModels'> & { calls: number };

function makeStub(models: CatalogRow[]): StubClient {
  const rows = models.map(catalogModel);
  const stub: StubClient = {
    calls: 0,
    listModels: async () => {
      stub.calls += 1;
      return rows;
    },
  };
  return stub;
}

const opus: CatalogRow = {
  id: 'anthropic/claude-opus-4.7',
  context_length: 200_000,
};
const gpt5: CatalogRow = { id: 'openai/gpt-5', context_length: 128_000 };

test('ModelLimitsRegistry is constructible', () => {
  const r = new ModelLimitsRegistry(makeStub([]));
  assert.ok(r instanceof ModelLimitsRegistry);
});

test('forModel returns context length from catalog', async () => {
  const stub = makeStub([opus, gpt5]);
  const r = new ModelLimitsRegistry(stub);
  const limits = await r.forModel('openai/gpt-5');
  assert.equal(limits.modelId, 'openai/gpt-5');
  assert.equal(limits.contextLength, 128_000);
});

test('forModel caches across calls — listModels invoked once', async () => {
  const stub = makeStub([opus, gpt5]);
  const r = new ModelLimitsRegistry(stub);
  await r.forModel('anthropic/claude-opus-4.7');
  await r.forModel('openai/gpt-5');
  await r.forModel('anthropic/claude-opus-4.7');
  assert.equal(stub.calls, 1);
});

test('preload populates cache and is idempotent', async () => {
  const stub = makeStub([opus]);
  const r = new ModelLimitsRegistry(stub);
  await r.preload();
  await r.preload();
  assert.equal(stub.calls, 1);
  const limits = await r.forModel('anthropic/claude-opus-4.7');
  assert.equal(limits.contextLength, 200_000);
  assert.equal(stub.calls, 1);
});

test('preload parses per-token pricing incl. cache read/write; blank/missing → undefined (issue #114)', async () => {
  const priced: CatalogRow = {
    id: 'anthropic/opus',
    context_length: 200_000,
    pricing: {
      prompt: '0.000005',
      completion: '0.000015',
      input_cache_read: '0.0000005',
      input_cache_write: '0.00000625',
    },
  };
  const noPricing: CatalogRow = { id: 'x/y', context_length: 1000 };
  const r = new ModelLimitsRegistry(makeStub([priced, noPricing]));
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
  const blank: CatalogRow = {
    id: 'blank/price',
    context_length: 1000,
    pricing: { prompt: '', completion: '   ' },
  };
  const r = new ModelLimitsRegistry(makeStub([blank]));
  const p = await r.forModel('blank/price');
  assert.equal(p.promptUsdPerToken, undefined, 'blank prompt → undefined, not 0');
  assert.equal(p.completionUsdPerToken, undefined, 'whitespace completion → undefined, not 0');
});

test('forModel throws ModelNotFound for unknown id', async () => {
  const stub = makeStub([opus]);
  const r = new ModelLimitsRegistry(stub);
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

test('concurrent preload() calls are memoized — only one listModels() round-trip', async () => {
  const stub = makeStub([opus, gpt5]);
  const r = new ModelLimitsRegistry(stub);
  // Fire three concurrent preload calls without awaiting sequentially.
  await Promise.all([r.preload(), r.preload(), r.preload()]);
  assert.equal(stub.calls, 1, 'only one listModels() call despite concurrent preload()');
});

test('concurrent forModel() calls are memoized via preload() — single listModels() round-trip', async () => {
  const stub = makeStub([opus, gpt5]);
  const r = new ModelLimitsRegistry(stub);
  // Fire concurrent forModel calls before any cache is populated.
  await Promise.all([
    r.forModel('anthropic/claude-opus-4.7'),
    r.forModel('openai/gpt-5'),
    r.forModel('anthropic/claude-opus-4.7'),
  ]);
  assert.equal(
    stub.calls,
    1,
    'only one listModels() call despite three concurrent forModel() calls',
  );
});

test('a failed load is not cached — a later preload() retries and succeeds', async () => {
  // First listModels() rejects (transient network/HTTP/schema failure), the second succeeds.
  let calls = 0;
  const flaky: Pick<OpenRouterClient, 'listModels'> = {
    listModels: async () => {
      calls += 1;
      if (calls === 1) throw new Error('catalog fetch failed');
      return [catalogModel(opus)];
    },
  };
  const r = new ModelLimitsRegistry(flaky);
  await assert.rejects(() => r.preload(), /catalog fetch failed/);
  // The rejected in-flight promise must be cleared so this retries instead of re-throwing.
  await r.preload();
  const limits = await r.forModel('anthropic/claude-opus-4.7');
  assert.equal(limits.contextLength, 200_000);
  assert.equal(calls, 2, 'exactly one retry after the initial failure');
});

// ---- reference-catalog fill (provider → OpenRouter list → unknown) --------

function stubCatalog(models: CatalogRow[]): { listModels: () => Promise<OpenRouterModel[]> } {
  const rows = models.map(catalogModel);
  return { listModels: async () => rows };
}

test('ModelLimitsRegistry: a provider publishing nothing gets both window and price from the reference', () => {
  // The z.ai coding endpoint, measured: its /models returns { id, object, created, owned_by } only.
  // Before this, that meant no window (Compactor permanently inert) and no price (cost unknown).
  return (async () => {
    const registry = new ModelLimitsRegistry(
      stubCatalog([{ id: 'glm-5.2' }]),
      stubCatalog([
        {
          id: 'z-ai/glm-5.2',
          context_length: 1_048_576,
          pricing: { prompt: '0.0000008', completion: '0.0000025', input_cache_read: '0.00000015' },
        },
      ]),
    );
    const limits = await registry.forModel('glm-5.2');
    assert.equal(limits.contextLength, 1_048_576);
    assert.equal(limits.contextSource, 'reference');
    assert.equal(limits.promptUsdPerToken, 0.0000008);
    assert.equal(limits.pricingSource, 'reference');
  })();
});

test('ModelLimitsRegistry: the provider wins on every field it publishes itself', async () => {
  const registry = new ModelLimitsRegistry(
    stubCatalog([
      {
        id: 'm',
        context_length: 111,
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
    ]),
    stubCatalog([{ id: 'x/m', context_length: 999, pricing: { prompt: '9', completion: '9' } }]),
  );
  const limits = await registry.forModel('m');
  assert.equal(limits.contextLength, 111);
  assert.equal(limits.promptUsdPerToken, 0.000001);
  assert.equal(limits.contextSource, 'provider');
  assert.equal(limits.pricingSource, 'provider');
});

test('ModelLimitsRegistry: a partially-published catalog keeps its window and borrows only the price', async () => {
  // kimi's endpoint, measured: context_length yes, pricing no.
  const registry = new ModelLimitsRegistry(
    stubCatalog([{ id: 'k3', context_length: 262_144 }]),
    stubCatalog([
      {
        id: 'moonshotai/kimi-k3',
        context_length: 1_048_576,
        pricing: { prompt: '0.000003', completion: '0.000015' },
      },
    ]),
  );
  const limits = await registry.forModel('k3');
  assert.equal(limits.contextLength, 262_144, "the provider's own window is authoritative");
  assert.equal(limits.contextSource, 'provider');
  assert.equal(limits.completionUsdPerToken, 0.000015);
  assert.equal(limits.pricingSource, 'reference');
});

test('ModelLimitsRegistry: missing maxOutputTokens is filled from reference', async () => {
  // Some providers publish everything except max_completion_tokens, so it must be fetched from reference.
  const registry = new ModelLimitsRegistry(
    stubCatalog([
      { id: 'm', context_length: 100_000, pricing: { prompt: '0.001', completion: '0.002' } },
    ]),
    stubCatalog([
      {
        id: 'x/m',
        context_length: 100_000,
        max_completion_tokens: 8_192,
        pricing: { prompt: '0.001', completion: '0.002' },
      },
    ]),
  );
  const limits = await registry.forModel('m');
  assert.equal(limits.maxOutputTokens, 8_192);
});

test('ModelLimitsRegistry: pricing is taken as a whole sheet, never half from each source', async () => {
  // A provider prompt rate paired with an OpenRouter completion rate describes no real price list.
  const registry = new ModelLimitsRegistry(
    stubCatalog([{ id: 'm', pricing: { prompt: '0.000001' } }]),
    stubCatalog([{ id: 'x/m', pricing: { prompt: '0.000008', completion: '0.000009' } }]),
  );
  const limits = await registry.forModel('m');
  assert.equal(limits.promptUsdPerToken, 0.000008);
  assert.equal(limits.completionUsdPerToken, 0.000009);
  assert.equal(limits.pricingSource, 'reference');
});

test('ModelLimitsRegistry: an unreachable reference catalog degrades to unknown, never throws', async () => {
  // The reference book is an enhancement; a third-party outage must not take a run down with it.
  const registry = new ModelLimitsRegistry(stubCatalog([{ id: 'm' }]), {
    listModels: async () => {
      throw new Error('network down');
    },
  });
  const limits = await registry.forModel('m');
  assert.equal(limits.contextLength, undefined);
  assert.equal(limits.promptUsdPerToken, undefined);
  assert.equal(limits.pricingSource, undefined);
});

test('ModelLimitsRegistry: with nothing missing the reference is never fetched', async () => {
  // A native OpenRouter profile must pay no extra request.
  let fetched = 0;
  const registry = new ModelLimitsRegistry(
    stubCatalog([
      {
        id: 'm',
        context_length: 10,
        max_completion_tokens: 5,
        pricing: { prompt: '0.1', completion: '0.2' },
      },
    ]),
    {
      listModels: async () => {
        fetched += 1;
        return [];
      },
    },
  );
  await registry.forModel('m');
  assert.equal(fetched, 0);
});

test('ModelLimitsRegistry: constructed without a reference it behaves exactly as before', async () => {
  const registry = new ModelLimitsRegistry(stubCatalog([{ id: 'm' }]));
  const limits = await registry.forModel('m');
  assert.deepEqual(limits, { modelId: 'm' });
});

test('ModelLimitsRegistry.all: every catalog model, resolved — the banner input', async () => {
  const registry = new ModelLimitsRegistry(
    stubCatalog([{ id: 'a' }, { id: 'b', context_length: 5 }]),
  );
  const all = await registry.all();
  assert.deepEqual(all.map((l) => l.modelId).sort(), ['a', 'b']);
});

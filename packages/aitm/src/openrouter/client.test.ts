import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  CATALOG_FETCH_TIMEOUT_MS,
  contextLengthOf,
  maxOutputTokensOf,
  OpenRouterClient,
  type OpenRouterModel,
  OpenRouterModelSchema,
  parseModelCatalog,
} from './client.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('OpenRouterClient is constructible', () => {
  const c = new OpenRouterClient('sk-or-test');
  assert.ok(c instanceof OpenRouterClient);
});

test('OpenRouterModelSchema validates the documented shape', () => {
  const parsed = OpenRouterModelSchema.parse({
    id: 'anthropic/claude-opus-4.7',
    context_length: 200_000,
    pricing: { prompt: '0.000015', completion: '0.000075' },
  });
  assert.equal(parsed.context_length, 200_000);
});

test('listModels GETs /models with Authorization and parses response', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'anthropic/claude-opus-4.7',
            name: 'Claude Opus 4.7',
            context_length: 200_000,
            pricing: { prompt: '0.000015', completion: '0.000075' },
          },
          {
            id: 'openai/gpt-5',
            context_length: 128_000,
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const c = new OpenRouterClient('sk-or-test', 'https://example.test/api/v1');
  const models = await c.listModels();

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://example.test/api/v1/models');
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer sk-or-test');

  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, 'anthropic/claude-opus-4.7');
  assert.equal(models[0]?.context_length, 200_000);
  assert.equal(models[1]?.id, 'openai/gpt-5');
});

test('listModels uses the default OpenRouter base URL when none is given', async () => {
  let observedUrl = '';
  globalThis.fetch = async (input) => {
    observedUrl = String(input);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const c = new OpenRouterClient('sk-or-test');
  await c.listModels();
  assert.equal(observedUrl, 'https://openrouter.ai/api/v1/models');
});

test('listModels throws with status and body excerpt on non-200', async () => {
  globalThis.fetch = async () =>
    new Response('upstream auth error: invalid token here', {
      status: 401,
      statusText: 'Unauthorized',
    });
  const c = new OpenRouterClient('sk-or-bad');
  await assert.rejects(
    () => c.listModels(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /401/);
      assert.match(err.message, /Unauthorized/);
      assert.match(err.message, /upstream auth error/);
      return true;
    },
  );
});

test('listModels surfaces Zod parse errors when the envelope shape is wrong', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ models: [] }), { status: 200 });
  const c = new OpenRouterClient('sk-or-test');
  await assert.rejects(() => c.listModels());
});

test('listModels keeps a model that publishes no context window', async () => {
  // A plain OpenAI-compatible /models — no context_length, no pricing. Rejecting the catalog here
  // would cost the run both autocompaction and cost accounting for every other model in it.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: 'glm-5.2' }] }), { status: 200 });
  const models = await new OpenRouterClient('sk-or-test').listModels();
  assert.deepEqual(
    models.map((m) => m.id),
    ['glm-5.2'],
  );
  assert.equal(contextLengthOf(models[0] as OpenRouterModel), undefined);
});

test('listModels drops a malformed entry instead of failing the catalog', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ data: [{ noId: true }, { id: 'kept', context_length: 128000 }] }),
      { status: 200 },
    );
  const models = await new OpenRouterClient('sk-or-test').listModels();
  assert.deepEqual(
    models.map((m) => m.id),
    ['kept'],
  );
});

test('contextLengthOf: accepts the spellings other OpenAI-compatible catalogs use', () => {
  const of = (raw: unknown): number | undefined =>
    contextLengthOf(OpenRouterModelSchema.parse(raw));
  assert.equal(of({ id: 'a', context_length: 200000 }), 200000);
  assert.equal(of({ id: 'b', top_provider: { context_length: 128000 } }), 128000);
  assert.equal(of({ id: 'c', max_model_len: 32768 }), 32768);
  assert.equal(of({ id: 'd', context_window: 8192 }), 8192);
  assert.equal(of({ id: 'e' }), undefined);
});

test('maxOutputTokensOf: reads the reply budget the Compactor reserves', () => {
  const of = (raw: unknown): number | undefined =>
    maxOutputTokensOf(OpenRouterModelSchema.parse(raw));
  assert.equal(of({ id: 'a', max_completion_tokens: 64_000 }), 64_000);
  assert.equal(of({ id: 'b', top_provider: { max_completion_tokens: 8_192 } }), 8_192);
  assert.equal(
    of({ id: 'c', max_completion_tokens: 4_096, top_provider: { max_completion_tokens: 8_192 } }),
    4_096,
    'the top-level field wins',
  );
  assert.equal(of({ id: 'd' }), undefined, 'a catalog that publishes none');
});

test('contextLengthOf: the top-level field wins over the per-provider one', () => {
  const model = OpenRouterModelSchema.parse({
    id: 'a',
    context_length: 200000,
    top_provider: { context_length: 64000 },
  });
  assert.equal(contextLengthOf(model), 200000);
});

test('parseModelCatalog: an explicit null numeric keeps the model instead of dropping it', () => {
  // Real shape from openrouter.ai: moonshotai/kimi-k3 ships `max_completion_tokens: null`. Under a
  // plain `.optional()` that failed the entry, the whole model vanished from the catalog, and a
  // vanished model has no context window (autocompaction off) and no price (cost unknown).
  const models = parseModelCatalog({
    data: [
      {
        id: 'moonshotai/kimi-k3',
        context_length: 1_048_576,
        top_provider: { context_length: 1_048_576, max_completion_tokens: null },
        pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: null },
      },
    ],
  });
  assert.equal(models.length, 1);
  const model = models[0];
  assert.ok(model);
  assert.equal(contextLengthOf(model), 1_048_576);
  assert.equal(maxOutputTokensOf(model), undefined);
  assert.equal(model.pricing?.prompt, '0.000003');
  assert.equal(model.pricing?.input_cache_read, undefined);
});

test('parseModelCatalog: a genuinely invalid entry is still dropped, and drops only itself', () => {
  const models = parseModelCatalog({
    data: [{ id: 'good/model', context_length: 100 }, { context_length: 5 }, { id: 'other/model' }],
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ['good/model', 'other/model'],
  );
});

test('listModels: the catalog fetch is time-boxed', async () => {
  // preload() runs at startup, and fillFromReference's try/catch guards a rejection, never a hang:
  // an endpoint that accepts the connection and then stalls would block the run before task one.
  let seen: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    seen = init?.signal ?? undefined;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  await new OpenRouterClient('sk-or-test').listModels();
  assert.ok(seen instanceof AbortSignal);
  assert.equal(seen.aborted, false);
});

test('listModels: the deadline expiring surfaces as a rejection, not a hang', async () => {
  // What the caller sees once AbortSignal.timeout fires: fetch rejects and listModels propagates it,
  // so ModelLimitsRegistry's try/catch can degrade instead of waiting forever.
  globalThis.fetch = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  await assert.rejects(
    () => new OpenRouterClient('sk-or-test', 'https://stalled.test/v1').listModels(),
    /TimeoutError|aborted/,
  );
  assert.ok(CATALOG_FETCH_TIMEOUT_MS > 0 && CATALOG_FETCH_TIMEOUT_MS <= 60_000);
});

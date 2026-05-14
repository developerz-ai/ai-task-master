import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { OpenRouterClient, OpenRouterModelSchema } from './client.ts';

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

test('listModels surfaces Zod parse errors when response shape is wrong', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 });
  const c = new OpenRouterClient('sk-or-test');
  await assert.rejects(() => c.listModels());
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlmFetch, detectRuntime, type UndiciAgentModule } from './llm-fetch.ts';

type AgentOptions = { keepAliveTimeout?: number; connections?: number };

// A fake undici Agent: records constructor options and instances so tests can assert the tuning and
// identity-match the dispatcher forwarded into the wrapped fetch. Instances are plain non-null
// objects, so the production `isDispatcher` trust-guard accepts them.
class FakeAgent {
  static instances: FakeAgent[] = [];
  static reset(): void {
    FakeAgent.instances = [];
  }
  readonly options: AgentOptions;
  constructor(options: AgentOptions) {
    this.options = options;
    FakeAgent.instances.push(this);
  }
}

const fakeUndici: UndiciAgentModule = { Agent: FakeAgent };

type FetchCall = { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] };

// A base-fetch spy that records each (input, init) and returns a fixed Response.
function makeSpyFetch(): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const spy: typeof fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response('ok'));
  };
  return { fetch: spy, calls };
}

test('llm-fetch: node path builds a keep-alive fetch with a tuned undici dispatcher', async () => {
  FakeAgent.reset();
  const spy = makeSpyFetch();
  const f = await createLlmFetch({
    runtime: 'node',
    loadUndici: async () => fakeUndici,
    baseFetch: spy.fetch,
  });
  assert(f, 'returns a wrapped fetch on Node when undici loads');

  // The Agent is constructed exactly once, tuned with the keep-alive settings.
  assert.equal(FakeAgent.instances.length, 1);
  assert.deepEqual(FakeAgent.instances[0]?.options, { keepAliveTimeout: 60_000, connections: 16 });

  const res = await f('https://openrouter.ai/api/v1/chat', {
    method: 'POST',
    headers: { 'x-test': '1' },
  });
  assert.equal(await res.text(), 'ok', 'forwards the base fetch response');
  assert.equal(spy.calls.length, 1);
  const call = spy.calls[0];
  assert.equal(call?.input, 'https://openrouter.ai/api/v1/chat', 'forwards the input unchanged');
  assert.equal(call?.init?.dispatcher, FakeAgent.instances[0], 'pins the tuned dispatcher');
  assert.equal(call?.init?.method, 'POST', 'preserves caller init fields');
  assert.deepEqual(call?.init?.headers, { 'x-test': '1' });
});

test('llm-fetch: wrapper injects the dispatcher even when the caller passes no init', async () => {
  FakeAgent.reset();
  const spy = makeSpyFetch();
  const f = await createLlmFetch({
    runtime: 'node',
    loadUndici: async () => fakeUndici,
    baseFetch: spy.fetch,
  });
  assert(f);
  await f('https://openrouter.ai/api/v1/models');
  assert.equal(spy.calls[0]?.init?.dispatcher, FakeAgent.instances[0]);
});

test('llm-fetch: node path with undici unavailable → undefined (provider keeps default fetch)', async () => {
  const f = await createLlmFetch({ runtime: 'node', loadUndici: async () => undefined });
  assert.equal(f, undefined);
});

test('llm-fetch: bun runtime → undefined and never imports undici (native pooling)', async () => {
  let loadCalls = 0;
  const f = await createLlmFetch({
    runtime: 'bun',
    loadUndici: async () => {
      loadCalls += 1;
      return fakeUndici;
    },
  });
  assert.equal(f, undefined);
  assert.equal(loadCalls, 0, 'undici is never loaded off-Node');
});

test('llm-fetch: deno runtime → undefined and never imports undici', async () => {
  let loadCalls = 0;
  const f = await createLlmFetch({
    runtime: 'deno',
    loadUndici: async () => {
      loadCalls += 1;
      return fakeUndici;
    },
  });
  assert.equal(f, undefined);
  assert.equal(loadCalls, 0);
});

test('llm-fetch: unknown runtime → undefined', async () => {
  const f = await createLlmFetch({ runtime: 'other', loadUndici: async () => fakeUndici });
  assert.equal(f, undefined);
});

test('llm-fetch: forced-node path with the real undici import pins a live dispatcher', async () => {
  const spy = makeSpyFetch();
  const f = await createLlmFetch({ runtime: 'node', baseFetch: spy.fetch });
  if (f === undefined) return; // undici not installed in this environment — nothing to assert
  await f('https://example.test/x', { method: 'POST' });
  assert.equal(spy.calls.length, 1);
  assert.ok(spy.calls[0]?.init?.dispatcher, 'a real undici dispatcher is pinned onto the request');
  assert.equal(spy.calls[0]?.init?.method, 'POST');
});

test('llm-fetch: on Bun the default factory returns undefined (global fetch)', async () => {
  if (process.versions.bun === undefined) return; // exercised under `bun test`
  const f = await createLlmFetch();
  assert.equal(f, undefined, 'Bun pools connections natively — no custom dispatcher');
});

test('llm-fetch: detectRuntime reports the active runtime', () => {
  const rt = detectRuntime();
  if (process.versions.bun !== undefined) assert.equal(rt, 'bun');
  else if ('Deno' in globalThis) assert.equal(rt, 'deno');
  else assert.equal(rt, 'node');
});

test('llm-fetch: default factory shape matches the active runtime', async () => {
  const f = await createLlmFetch();
  if (detectRuntime() === 'node') {
    // undici is an installed optional dep in dev/CI → a wrapped fetch; a stripped env degrades to
    // undefined. Both are valid; assert the shape rather than coupling to install state.
    assert.ok(f === undefined || typeof f === 'function');
  } else {
    assert.equal(f, undefined);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLlmFetch,
  detectRuntime,
  isKeepAliveAgent,
  type UndiciAgentModule,
} from './llm-fetch.ts';

type AgentOptions = { keepAliveTimeout?: number; connections?: number };

// A fake undici Agent: records constructor options and instances so tests can assert the tuning and
// identity-match the dispatcher forwarded into the wrapped fetch. Instances are plain non-null
// objects carrying `destroy`, so the production `isKeepAliveAgent` trust-guard accepts them.
class FakeAgent {
  static instances: FakeAgent[] = [];
  static reset(): void {
    FakeAgent.instances = [];
  }
  readonly options: AgentOptions;
  destroyCalls = 0;
  constructor(options: AgentOptions) {
    this.options = options;
    FakeAgent.instances.push(this);
  }
  destroy(): Promise<void> {
    this.destroyCalls += 1;
    return Promise.resolve();
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
  const handle = await createLlmFetch({
    runtime: 'node',
    loadUndici: async () => fakeUndici,
    baseFetch: spy.fetch,
  });
  assert(handle, 'returns a transport handle on Node when undici loads');

  // The Agent is constructed exactly once, tuned with the keep-alive settings.
  assert.equal(FakeAgent.instances.length, 1);
  assert.deepEqual(FakeAgent.instances[0]?.options, { keepAliveTimeout: 60_000, connections: 16 });

  const res = await handle.fetch('https://openrouter.ai/api/v1/chat', {
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
  const handle = await createLlmFetch({
    runtime: 'node',
    loadUndici: async () => fakeUndici,
    baseFetch: spy.fetch,
  });
  assert(handle);
  await handle.fetch('https://openrouter.ai/api/v1/models');
  assert.equal(spy.calls[0]?.init?.dispatcher, FakeAgent.instances[0]);
});

test("llm-fetch: a caller's own dispatcher survives — the keep-alive one is not forced on", async () => {
  FakeAgent.reset();
  const spy = makeSpyFetch();
  const handle = await createLlmFetch({
    runtime: 'node',
    loadUndici: async () => fakeUndici,
    baseFetch: spy.fetch,
  });
  assert(handle);
  // The same trivial fake the module's own doc-comment blesses, narrowed through the module's own
  // predicate so it types as a dispatcher without restating the whole Dispatcher surface. A REAL
  // undici Agent would be wrong here: under Bun it carries no `destroy`, so this would pass on Node
  // and fail on Bun — and the repo's runtime stance is that code runs unchanged on both.
  const fake: unknown = new FakeAgent({});
  assert.ok(isKeepAliveAgent(fake), 'the fake carries destroy, so it is a keep-alive dispatcher');
  const callerDispatcher = fake;
  await handle.fetch('https://openrouter.ai/api/v1/chat', {
    method: 'POST',
    dispatcher: callerDispatcher,
  });
  assert.equal(spy.calls[0]?.init?.dispatcher, callerDispatcher, 'keeps the caller-set dispatcher');
  assert.equal(spy.calls[0]?.init?.method, 'POST');
});

test('llm-fetch: close() destroys the agent, releasing the pooled sockets', async () => {
  FakeAgent.reset();
  const handle = await createLlmFetch({
    runtime: 'node',
    loadUndici: async () => fakeUndici,
    baseFetch: makeSpyFetch().fetch,
  });
  assert(handle);
  const agent = FakeAgent.instances[0];
  assert.equal(agent?.destroyCalls, 0, 'nothing is torn down before close()');
  await handle.close();
  assert.equal(agent?.destroyCalls, 1);
});

test('llm-fetch: close() is idempotent → a double drain destroys once and never rejects', async () => {
  FakeAgent.reset();
  const handle = await createLlmFetch({
    runtime: 'node',
    loadUndici: async () => fakeUndici,
    baseFetch: makeSpyFetch().fetch,
  });
  assert(handle);
  await handle.close();
  await handle.close();
  await Promise.all([handle.close(), handle.close()]);
  assert.equal(FakeAgent.instances[0]?.destroyCalls, 1);
});

test('llm-fetch: an agent with no destroy() → undefined (never hand out an unreleasable pool)', async () => {
  class UnreleasableAgent {}
  const handle = await createLlmFetch({
    runtime: 'node',
    loadUndici: async () => ({ Agent: UnreleasableAgent }),
    baseFetch: makeSpyFetch().fetch,
  });
  assert.equal(handle, undefined);
});

test('llm-fetch: node path with undici unavailable → undefined (provider keeps default fetch)', async () => {
  const handle = await createLlmFetch({ runtime: 'node', loadUndici: async () => undefined });
  assert.equal(handle, undefined);
});

test('llm-fetch: bun runtime → undefined and never imports undici (native pooling)', async () => {
  let loadCalls = 0;
  const handle = await createLlmFetch({
    runtime: 'bun',
    loadUndici: async () => {
      loadCalls += 1;
      return fakeUndici;
    },
  });
  assert.equal(handle, undefined);
  assert.equal(loadCalls, 0, 'undici is never loaded off-Node');
});

test('llm-fetch: deno runtime → undefined and never imports undici', async () => {
  let loadCalls = 0;
  const handle = await createLlmFetch({
    runtime: 'deno',
    loadUndici: async () => {
      loadCalls += 1;
      return fakeUndici;
    },
  });
  assert.equal(handle, undefined);
  assert.equal(loadCalls, 0);
});

test('llm-fetch: unknown runtime → undefined', async () => {
  const handle = await createLlmFetch({ runtime: 'other', loadUndici: async () => fakeUndici });
  assert.equal(handle, undefined);
});

test('llm-fetch: forced-node path with the real undici import pins a live dispatcher', async () => {
  const spy = makeSpyFetch();
  const handle = await createLlmFetch({ runtime: 'node', baseFetch: spy.fetch });
  if (handle === undefined) return; // undici not installed in this environment — nothing to assert
  await handle.fetch('https://example.test/x', { method: 'POST' });
  assert.equal(spy.calls.length, 1);
  assert.ok(spy.calls[0]?.init?.dispatcher, 'a real undici dispatcher is pinned onto the request');
  assert.equal(spy.calls[0]?.init?.method, 'POST');
  // A real Agent's destroy() must settle — otherwise run teardown would hang on it.
  await handle.close();
  await handle.close();
});

test('llm-fetch: on Bun the default factory returns undefined (global fetch)', async () => {
  if (process.versions.bun === undefined) return; // exercised under `bun test`
  const handle = await createLlmFetch();
  assert.equal(handle, undefined, 'Bun pools connections natively — no custom dispatcher');
});

test('llm-fetch: detectRuntime reports the active runtime', () => {
  const rt = detectRuntime();
  if (process.versions.bun !== undefined) assert.equal(rt, 'bun');
  else if ('Deno' in globalThis) assert.equal(rt, 'deno');
  else assert.equal(rt, 'node');
});

test('llm-fetch: default factory shape matches the active runtime', async () => {
  const handle = await createLlmFetch();
  if (detectRuntime() === 'node') {
    // undici is an installed optional dep in dev/CI → a transport handle; a stripped env degrades to
    // undefined. Both are valid; assert the shape rather than coupling to install state.
    assert.ok(handle === undefined || typeof handle.fetch === 'function');
    await handle?.close();
  } else {
    assert.equal(handle, undefined);
  }
});

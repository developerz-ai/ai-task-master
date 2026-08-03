// docs/runtime.md §"HTTP transport", docs/auth.md §"Provider wiring".
// A keep-alive `fetch` for the LLM inference path. On Node the global fetch is undici-backed but
// uses the default global dispatcher (4s keep-alive, unbounded per-origin pool); one run makes
// hundreds of sequential calls to a single OpenRouter host, so a tuned Agent (long keep-alive +
// bounded pool) avoids repeated TCP/TLS handshakes between the model's think/tool gaps. Bun and
// Deno pool keep-alive connections natively, so they keep the runtime default. `undici` is an
// optional dependency: off-Node, or when it can't be loaded, the factory returns undefined and the
// provider keeps its own default fetch (byte-identical request path). Never touches `Bun.*` — the
// runtime is feature-detected; portability is a hard rule.

import process from 'node:process';

export type Runtime = 'node' | 'bun' | 'deno' | 'other';

// The dispatcher type Node's global fetch accepts on `RequestInit` (sourced from undici-types via
// @types/node). We narrow the constructed Agent to this so `init.dispatcher` typechecks against the
// global fetch — see `isDispatcher`.
export type KeepAliveDispatcher = NonNullable<RequestInit['dispatcher']>;

// The single slice of undici we construct. The `Agent` return is `unknown` on purpose: undici@7's
// `Agent` and the undici-types@7 `Dispatcher` behind Node's global fetch drift between versions, so
// a direct type match fails; we narrow the constructed value instead (`isDispatcher`). `unknown`
// also lets tests inject a trivial fake Agent without reimplementing the whole Dispatcher surface.
export type UndiciAgentModule = {
  Agent: new (options: { keepAliveTimeout?: number; connections?: number }) => unknown;
};

export type LlmFetchOptions = {
  // Injected in tests to exercise each runtime branch deterministically; defaults to detection.
  runtime?: Runtime;
  // Injected in tests to stand in for `import('undici')`; defaults to the real optional import.
  loadUndici?: () => Promise<UndiciAgentModule | undefined>;
  // Injected in tests to observe forwarded requests; defaults to the global fetch.
  baseFetch?: typeof fetch;
};

// The keep-alive transport plus the handle that releases it. The pool holds idle sockets open for
// KEEP_ALIVE_TIMEOUT_MS, which keeps Node's event loop alive that long past the run, so the owner
// registers `close` on the run's Disposer instead of leaking one Agent per call.
export type LlmFetch = {
  fetch: typeof fetch;
  // Idempotent — a second call is a no-op, so double-draining a Disposer can't reject.
  close: () => Promise<void>;
};

// 60s keep-alive holds the OpenRouter connection open across a model's think/tool gaps; 16
// connections bounds the pool while still covering the parallel editor-team fanout.
const KEEP_ALIVE_TIMEOUT_MS = 60_000;
const MAX_CONNECTIONS = 16;

export function detectRuntime(): Runtime {
  // Order matters: Bun and Deno both shim `process.versions.node`, so probe them first.
  if (typeof process !== 'undefined' && process.versions?.bun !== undefined) return 'bun';
  if ('Deno' in globalThis) return 'deno';
  if (typeof process !== 'undefined' && process.versions?.node !== undefined) return 'node';
  return 'other';
}

// A dispatcher we can also tear down. `destroy` (not `close`) is what the release path calls, so a
// value lacking it is not usable here — see `createLlmFetch`.
export type KeepAliveAgent = KeepAliveDispatcher & { destroy: () => unknown };

// A constructed undici Agent is a valid global-fetch dispatcher at runtime; the two undici type
// versions differ only nominally, so trust the shape rather than casting.
export function isKeepAliveAgent(value: unknown): value is KeepAliveAgent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  );
}

async function importUndici(): Promise<UndiciAgentModule | undefined> {
  try {
    const { Agent } = await import('undici');
    return { Agent };
  } catch {
    // Optional dep not installed / unsupported runtime — fall back to the default fetch.
    return undefined;
  }
}

// Build the keep-alive transport and its release handle, or undefined when the runtime already pools
// connections (Bun/Deno) or undici is unavailable. Undefined signals `providerSettings` to omit
// `fetch` and keep the provider's default transport, so the non-Node request path stays
// byte-identical. The caller OWNS the returned handle and must register `close` on the run's
// Disposer.
export async function createLlmFetch(options: LlmFetchOptions = {}): Promise<LlmFetch | undefined> {
  const runtime = options.runtime ?? detectRuntime();
  if (runtime !== 'node') return undefined;

  const loadUndici = options.loadUndici ?? importUndici;
  const undici = await loadUndici();
  if (!undici) return undefined;

  const dispatcher = new undici.Agent({
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    connections: MAX_CONNECTIONS,
  });
  if (!isKeepAliveAgent(dispatcher)) return undefined;

  const baseFetch = options.baseFetch ?? globalThis.fetch;
  // Only fill in the dispatcher the caller left unset. Overwriting it unconditionally silently
  // discarded a caller's own transport (a mock, a proxy agent) while still reporting success.
  const keepAliveFetch: typeof fetch = (input, init) =>
    baseFetch(input, init?.dispatcher === undefined ? { ...init, dispatcher } : init);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // `destroy`, not `close`: close() waits for in-flight requests, and one stuck request would hang
    // run teardown — and with it the CLI's exit — forever. Nothing is in flight at run end (every
    // model call is awaited), so this is a socket release, not a cancellation.
    await dispatcher.destroy();
  };

  return { fetch: keepAliveFetch, close };
}

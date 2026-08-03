import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MCPClient, MCPClientConfig } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import { jsonSchema } from 'ai';
import type { LoggerLike } from '../logger/logger.ts';
import { type CreateMcpClient, McpClientManager, mcpInitFrom } from './mcp-client.ts';
import { StdioProcessRegistry } from './stdio-process-registry.ts';

type FakeClient = MCPClient & {
  closeCalls: number;
  toolsValue: ToolSet;
};

type Recorded = { config: MCPClientConfig; name: string };

// Like testing/mcp-client-double.ts, but counting its own close() calls — which is the whole point
// of the tests below. `tools` is cast at the VALUE: the SDK method's declared return is
// McpToolSet<T> for a caller-chosen T, which a concrete ToolSet cannot be, and Promise<never>
// satisfies every T. The partial is deliberate — this manager reaches `tools` and `close`, nothing
// else on the protocol.
function fakeClient(tools: ToolSet): FakeClient {
  const client: Partial<FakeClient> = {
    closeCalls: 0,
    toolsValue: tools,
    tools: async () => tools as never,
    close: async () => {
      (client as FakeClient).closeCalls += 1;
    },
  };
  return client as FakeClient;
}

function fakeTool(): ToolSet[string] {
  return { description: 't', inputSchema: jsonSchema({ type: 'object' }) };
}

// A promise that never settles — stands in for an SDK call wedged mid-handshake or a no-op close.
function pending<T = never>(): Promise<T> {
  return new Promise<T>(() => {});
}

function recordingLogger(): {
  logger: LoggerLike;
  warnings: Array<{ msg: string; fields: Record<string, unknown> | undefined }>;
} {
  const warnings: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: Record<string, unknown>) => {
      warnings.push({ msg, fields });
    },
    error: () => {},
    status: () => {},
    flush: async () => {},
  };
  return { logger, warnings };
}

function recordingFactory(map: Record<string, ToolSet>): {
  createClient: CreateMcpClient;
  clientsByName: Map<string, FakeClient>;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  const clientsByName = new Map<string, FakeClient>();
  const createClient: CreateMcpClient = async (config) => {
    const name = (config.clientName ?? '').replace(/^aitm-/, '');
    recorded.push({ config, name });
    const tools = map[name] ?? {};
    const client = fakeClient(tools);
    clientsByName.set(name, client);
    return client;
  };
  return { createClient, clientsByName, recorded };
}

test('McpClientManager is constructible (skeleton)', () => {
  const m = new McpClientManager({ servers: {} });
  assert.ok(m instanceof McpClientManager);
});

test('connectAll with no servers yields empty connected() + tools', async () => {
  const m = new McpClientManager({ servers: {} });
  await m.connectAll();
  assert.deepEqual(m.connected(), []);
  assert.deepEqual(m.toolsForRole('worker'), {});
  await m.close();
});

test('connectAll spawns one client per server and exposes tools per role', async () => {
  const { createClient, recorded } = recordingFactory({
    filesystem: { fs_read: fakeTool() },
    api: { http_get: fakeTool() },
  });

  const m = new McpClientManager({
    servers: {
      filesystem: { command: 'npx', args: ['fs'] },
      api: { type: 'http', url: 'https://example.com/mcp' },
    },
    createClient,
  });
  await m.connectAll();

  assert.equal(recorded.length, 2);
  const connected = m.connected();
  assert.equal(connected.length, 2);
  assert.deepEqual(connected.map((c) => c.transport).sort(), ['http', 'stdio']);
  const tools = m.toolsForRole('worker');
  // Namespaced `mcp__<server>__<tool>` — no un-namespaced keys (issue #115).
  assert.deepEqual(Object.keys(tools).sort(), ['mcp__api__http_get', 'mcp__filesystem__fs_read']);
});

test('toolsForRole respects roleAllowlist array form (filters by server name)', async () => {
  const { createClient } = recordingFactory({
    filesystem: { fs_read: fakeTool() },
    git: { git_status: fakeTool() },
    payments: { pay: fakeTool() },
  });

  const m = new McpClientManager({
    servers: {
      filesystem: { command: 'fs' },
      git: { command: 'git-mcp' },
      payments: { command: 'pay-mcp' },
    },
    roleAllowlist: {
      worker: ['filesystem'],
      reviewer: ['git'],
    },
    createClient,
  });
  await m.connectAll();

  assert.deepEqual(Object.keys(m.toolsForRole('worker')), ['mcp__filesystem__fs_read']);
  assert.deepEqual(Object.keys(m.toolsForRole('reviewer')), ['mcp__git__git_status']);
  // Unlisted role (planner) sees every server.
  assert.deepEqual(Object.keys(m.toolsForRole('planner')).sort(), [
    'mcp__filesystem__fs_read',
    'mcp__git__git_status',
    'mcp__payments__pay',
  ]);
});

test('connectAll logs and skips failed servers without throwing', async () => {
  const { createClient: ok } = recordingFactory({ good: { good_tool: fakeTool() } });
  const warnings: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: Record<string, unknown>) => {
      warnings.push({ msg, fields });
    },
    error: () => {},
    status: () => {},
    flush: async () => {},
  };

  const createClient: CreateMcpClient = async (config) => {
    if (config.clientName === 'aitm-broken') throw new Error('boom');
    return ok(config);
  };

  const m = new McpClientManager({
    servers: {
      good: { command: 'g' },
      broken: { command: 'b' },
    },
    createClient,
    logger,
  });
  await m.connectAll();

  assert.equal(m.connected().length, 1);
  assert.equal(m.connected()[0]?.name, 'good');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.msg ?? '', /mcp server connect failed/);
  assert.equal(warnings[0]?.fields?.name, 'broken');
});

test('close() calls client.close() on every connected server and clears connected()', async () => {
  const { createClient, clientsByName } = recordingFactory({
    a: { a_tool: fakeTool() },
    b: { b_tool: fakeTool() },
  });
  const m = new McpClientManager({
    servers: {
      a: { command: 'a' },
      b: { command: 'b' },
    },
    createClient,
  });
  await m.connectAll();
  await m.close();

  assert.equal(clientsByName.get('a')?.closeCalls, 1);
  assert.equal(clientsByName.get('b')?.closeCalls, 1);
  assert.deepEqual(m.connected(), []);
});

test('close() swallows per-client close errors and still clears state', async () => {
  const createClient: CreateMcpClient = async (config) => {
    const c = fakeClient({ t: fakeTool() });
    if (config.clientName === 'aitm-bad') {
      c.close = async () => {
        throw new Error('close-fail');
      };
    }
    return c;
  };
  const warnings: string[] = [];
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => {
      warnings.push(msg);
    },
    error: () => {},
    status: () => {},
    flush: async () => {},
  };
  const m = new McpClientManager({
    servers: { bad: { command: 'x' } },
    createClient,
    logger,
  });
  await m.connectAll();
  await m.close();
  assert.deepEqual(m.connected(), []);
  assert.equal(warnings.length, 1);
});

test('connected() reports tool counts and transport per server', async () => {
  const { createClient } = recordingFactory({
    fs: { a: fakeTool(), b: fakeTool() },
    web: { x: fakeTool() },
  });
  const m = new McpClientManager({
    servers: {
      fs: { command: 'fs' },
      web: { type: 'sse', url: 'https://example.com/sse' },
    },
    createClient,
  });
  await m.connectAll();

  const conn = m.connected();
  const byName = Object.fromEntries(conn.map((c) => [c.name, c]));
  assert.equal(byName.fs?.toolCount, 2);
  assert.equal(byName.fs?.transport, 'stdio');
  assert.equal(byName.web?.toolCount, 1);
  assert.equal(byName.web?.transport, 'sse');
});

test('connectAll closes the client when tools() throws and logs both failures', async () => {
  const warnings: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: Record<string, unknown>) => {
      warnings.push({ msg, fields });
    },
    error: () => {},
    status: () => {},
    flush: async () => {},
  };
  const created: FakeClient[] = [];
  const createClient: CreateMcpClient = async (_config) => {
    const c = fakeClient({});
    c.tools = async () => {
      throw new Error('tools-boom');
    };
    created.push(c);
    return c;
  };

  const m = new McpClientManager({
    servers: { flaky: { command: 'x' } },
    createClient,
    logger,
  });
  await m.connectAll();

  assert.equal(m.connected().length, 0);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.closeCalls, 1);
  const messages = warnings.map((w) => w.msg);
  assert.ok(messages.includes('mcp server connect failed'));
});

test('connectAll surfaces cleanup failures separately from the original error', async () => {
  const warnings: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: Record<string, unknown>) => {
      warnings.push({ msg, fields });
    },
    error: () => {},
    status: () => {},
    flush: async () => {},
  };
  const createClient: CreateMcpClient = async (_config) => {
    const c = fakeClient({});
    c.tools = async () => {
      throw new Error('tools-boom');
    };
    c.close = async () => {
      throw new Error('close-boom');
    };
    return c;
  };

  const m = new McpClientManager({
    servers: { flaky: { command: 'x' } },
    createClient,
    logger,
  });
  await m.connectAll();

  const messages = warnings.map((w) => w.msg);
  assert.ok(messages.includes('mcp server cleanup failed'));
  assert.ok(messages.includes('mcp server connect failed'));
});

test('two servers exporting the same tool name both survive as distinct namespaced keys, no warning (issue #115)', async () => {
  const warnings: string[] = [];
  const logger: LoggerLike = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
    status: () => {},
    flush: async () => {},
  };
  const firstTool = fakeTool();
  const secondTool = fakeTool();
  const { createClient } = recordingFactory({
    alpha: { shared: firstTool },
    beta: { shared: secondTool },
  });

  const m = new McpClientManager({
    servers: { alpha: { command: 'a' }, beta: { command: 'b' } },
    createClient,
    logger,
  });
  await m.connectAll();
  const tools = m.toolsForRole('worker');

  // Both survive under distinct namespaced keys — no drop, no duplicate warning.
  assert.deepEqual(Object.keys(tools).sort(), ['mcp__alpha__shared', 'mcp__beta__shared']);
  assert.strictEqual(tools.mcp__alpha__shared, firstTool);
  assert.strictEqual(tools.mcp__beta__shared, secondTool);
  assert.equal(warnings.length, 0);
});

test('toolsForRole record-form allowlist filters per tool per role with `*` globs (issue #115)', async () => {
  const { createClient } = recordingFactory({
    filesystem: { read_file: fakeTool(), list_dir: fakeTool(), write_file: fakeTool() },
    git: { git_status: fakeTool() },
  });
  const m = new McpClientManager({
    servers: { filesystem: { command: 'fs' }, git: { command: 'git-mcp' } },
    roleAllowlist: {
      // Planner: only the read-only filesystem tools; git absent from the record → not mounted.
      planner: { filesystem: ['read_*', 'list_*'] },
    },
    createClient,
  });
  await m.connectAll();

  assert.deepEqual(Object.keys(m.toolsForRole('planner')).sort(), [
    'mcp__filesystem__list_dir',
    'mcp__filesystem__read_file',
  ]);
  // write_file did not match; git was not a key in the record → dropped for planner.
  assert.ok(!Object.keys(m.toolsForRole('planner')).some((k) => k.includes('write_file')));
  assert.ok(!Object.keys(m.toolsForRole('planner')).some((k) => k.includes('git')));
});

test('server names are sanitized (charset + collapsed __) so the namespace round-trips (issue #115)', async () => {
  const { createClient } = recordingFactory({
    'my server.v2': { ping: fakeTool() },
    my__srv: { pong: fakeTool() },
  });
  const m = new McpClientManager({
    servers: { 'my server.v2': { command: 'x' }, my__srv: { command: 'y' } },
    createClient,
  });
  await m.connectAll();
  // Spaces/dots → `-`; a `__` in the name is collapsed to `-` so it can't collide with the delimiter,
  // keeping `mcp__<server>__<tool>` splittable back to the tool.
  assert.deepEqual(Object.keys(m.toolsForRole('worker')).sort(), [
    'mcp__my-server-v2__ping',
    'mcp__my-srv__pong',
  ]);
});

test('record allowlist ignores inherited object properties (no throw on a toString server) (issue #115)', async () => {
  const { createClient } = recordingFactory({
    filesystem: { read_file: fakeTool() },
    toString: { danger: fakeTool() },
  });
  const m = new McpClientManager({
    servers: { filesystem: { command: 'fs' }, toString: { command: 'x' } },
    // The record has no `toString` key; the own-property guard must not read Object.prototype.toString.
    roleAllowlist: { worker: { filesystem: ['read_*'] } },
    createClient,
  });
  await m.connectAll();
  assert.doesNotThrow(() => m.toolsForRole('worker'));
  assert.deepEqual(Object.keys(m.toolsForRole('worker')), ['mcp__filesystem__read_file']);
});

test('http transport propagates headers through client config', async () => {
  const { createClient, recorded } = recordingFactory({ api: {} });
  const m = new McpClientManager({
    servers: {
      api: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer xyz' },
      },
    },
    createClient,
  });
  await m.connectAll();
  const cfg = recorded[0]?.config;
  assert.ok(cfg);
  const transport = cfg.transport as {
    type: string;
    url: string;
    headers?: Record<string, string>;
  };
  assert.equal(transport.type, 'http');
  assert.equal(transport.url, 'https://example.com/mcp');
  assert.equal(transport.headers?.Authorization, 'Bearer xyz');
});

// ---- toolSurfaceForRole: deferred-loading split (issue #119) ----

test('toolSurfaceForRole: at or below the threshold, every tool mounts direct — no deferral (issue #119)', async () => {
  const { createClient } = recordingFactory({ srv: { a: fakeTool(), b: fakeTool() } });
  const m = new McpClientManager({
    servers: { srv: { command: 'x' } },
    deferToolsOver: 2,
    createClient,
  });
  await m.connectAll();
  const surface = m.toolSurfaceForRole('worker');
  assert.deepEqual(Object.keys(surface.direct).sort(), ['mcp__srv__a', 'mcp__srv__b']);
  assert.deepEqual(surface.deferred, {});
  await m.close();
});

test('toolSurfaceForRole: above the threshold, the whole surplus defers (issue #119)', async () => {
  const { createClient } = recordingFactory({
    srv: { a: fakeTool(), b: fakeTool(), c: fakeTool() },
  });
  const m = new McpClientManager({
    servers: { srv: { command: 'x' } },
    deferToolsOver: 2,
    createClient,
  });
  await m.connectAll();
  const surface = m.toolSurfaceForRole('worker');
  assert.deepEqual(surface.direct, {});
  assert.deepEqual(Object.keys(surface.deferred).sort(), [
    'mcp__srv__a',
    'mcp__srv__b',
    'mcp__srv__c',
  ]);
  await m.close();
});

test('toolSurfaceForRole: threshold 0 always defers any surplus (issue #119)', async () => {
  const { createClient } = recordingFactory({ srv: { only: fakeTool() } });
  const m = new McpClientManager({
    servers: { srv: { command: 'x' } },
    deferToolsOver: 0,
    createClient,
  });
  await m.connectAll();
  const surface = m.toolSurfaceForRole('worker');
  assert.deepEqual(surface.direct, {});
  assert.deepEqual(Object.keys(surface.deferred), ['mcp__srv__only']);
  await m.close();
});

test('toolSurfaceForRole: no threshold set uses the default (20) — a small registry stays direct (issue #119)', async () => {
  const { createClient } = recordingFactory({ srv: { a: fakeTool() } });
  const m = new McpClientManager({ servers: { srv: { command: 'x' } }, createClient });
  await m.connectAll();
  const surface = m.toolSurfaceForRole('worker');
  assert.deepEqual(Object.keys(surface.direct), ['mcp__srv__a']);
  assert.deepEqual(surface.deferred, {});
  await m.close();
});

test('toolSurfaceForRole: the split honors the per-role allowlist (issue #119)', async () => {
  const { createClient } = recordingFactory({ a: { x: fakeTool() }, b: { y: fakeTool() } });
  const m = new McpClientManager({
    servers: { a: { command: 'x' }, b: { command: 'y' } },
    roleAllowlist: { worker: ['a'] },
    deferToolsOver: 0,
    createClient,
  });
  await m.connectAll();
  const surface = m.toolSurfaceForRole('worker');
  // Only server `a` is mounted for the worker, so only its tool appears — then defers at threshold 0.
  assert.deepEqual(Object.keys(surface.deferred), ['mcp__a__x']);
  assert.deepEqual(surface.direct, {});
  await m.close();
});

// ---- connect/close deadlines: no MCP path may hang forever (slice 04) ----

test('connectAll: a server that spawns but never finishes tools() is skipped after connectTimeoutMs', async () => {
  const { logger, warnings } = recordingLogger();
  const createClient: CreateMcpClient = async () => {
    const c = fakeClient({});
    c.tools = () => pending();
    return c;
  };
  const m = new McpClientManager({
    servers: { wedged: { command: 'x' } },
    createClient,
    connectTimeoutMs: 20,
    logger,
  });

  await m.connectAll();

  assert.equal(m.connected().length, 0);
  const failed = warnings.find((w) => w.msg === 'mcp server connect failed');
  assert.ok(failed, 'expected a connect-failed warning');
  assert.equal(failed?.fields?.name, 'wedged');
  assert.match(String(failed?.fields?.error), /timed out/);
  await m.close();
});

test('connectAll: a client that connects then wedges on tools() is still closed after the deadline', async () => {
  const c = fakeClient({});
  c.tools = () => pending();
  const createClient: CreateMcpClient = async () => c;
  const m = new McpClientManager({
    servers: { wedged: { command: 'x' } },
    createClient,
    connectTimeoutMs: 20,
  });

  await m.connectAll();

  assert.equal(m.connected().length, 0);
  // createClient resolved before tools() wedged, so cleanup must close the connected client.
  assert.equal(c.closeCalls, 1);
});

test('connectAll: a createClient that never resolves is skipped after the deadline without throwing', async () => {
  const { logger, warnings } = recordingLogger();
  const createClient: CreateMcpClient = () => pending();
  const m = new McpClientManager({
    servers: { wedged: { command: 'x' } },
    createClient,
    connectTimeoutMs: 20,
    logger,
  });

  await assert.doesNotReject(() => m.connectAll());

  assert.equal(m.connected().length, 0);
  assert.ok(warnings.some((w) => w.msg === 'mcp server connect failed'));
  await m.close();
});

test('close: a client.close() that never returns does not block terminate() (time-boxed batch)', async () => {
  const { logger, warnings } = recordingLogger();
  const c = fakeClient({ t: fakeTool() });
  c.close = () => pending();
  const createClient: CreateMcpClient = async () => c;

  const registry = new StdioProcessRegistry({
    kill: () => {},
    exitHooks: { on: () => {}, off: () => {} },
  });
  let terminateCalls = 0;
  const realTerminate = registry.terminate.bind(registry);
  registry.terminate = async () => {
    terminateCalls += 1;
    await realTerminate();
  };

  const m = new McpClientManager({
    servers: { wedged: { command: 'x' } },
    createClient,
    processes: registry,
    closeTimeoutMs: 20,
    logger,
  });
  await m.connectAll();
  assert.equal(m.connected().length, 1);

  await m.close();

  assert.equal(terminateCalls, 1, 'terminate() must run even when a client.close() hangs');
  assert.deepEqual(m.connected(), []);
  assert.ok(warnings.some((w) => w.msg === 'mcp close batch timed out'));
});

// ---- parallel connect: servers handshake concurrently, one failure never blocks the rest (#79) ----

test('connectAll connects servers concurrently, not one-at-a-time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const createClient: CreateMcpClient = async (config) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // A real handshake yields; a truly-parallel connectAll holds both createClient calls in flight
    // here at once, whereas a serial loop only ever has one before it awaits the next.
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    const name = (config.clientName ?? '').replace(/^aitm-/, '');
    return fakeClient({ [`${name}_tool`]: fakeTool() });
  };
  const m = new McpClientManager({
    servers: { a: { command: 'a' }, b: { command: 'b' } },
    createClient,
  });

  await m.connectAll();

  assert.equal(maxInFlight, 2, 'both servers must be mid-connect at once (parallel, not serial)');
  // Pushed in input order regardless of which handshake finished first.
  assert.deepEqual(
    m.connected().map((c) => c.name),
    ['a', 'b'],
  );
  await m.close();
});

test('connectAll: a partial failure closes the wedged client but keeps the good one connected', async () => {
  const { logger, warnings } = recordingLogger();
  const wedged = fakeClient({});
  wedged.tools = () => pending(); // connects, then never finishes the handshake
  const good = fakeClient({ ok_tool: fakeTool() });
  const createClient: CreateMcpClient = async (config) =>
    config.clientName === 'aitm-wedged' ? wedged : good;

  const m = new McpClientManager({
    servers: { good: { command: 'g' }, wedged: { command: 'w' } },
    createClient,
    connectTimeoutMs: 20,
    logger,
  });

  await m.connectAll();

  // The good server survived; the wedged one was skipped after the deadline.
  assert.deepEqual(
    m.connected().map((c) => c.name),
    ['good'],
  );
  // The wedged client connected before tools() hung, so its cleanup close ran; the good one is untouched.
  assert.equal(wedged.closeCalls, 1);
  assert.equal(good.closeCalls, 0);
  const failed = warnings.find((w) => w.msg === 'mcp server connect failed');
  assert.equal(failed?.fields?.name, 'wedged');
  await m.close();
});

test('connectAll: a stdio child spawned before a mid-handshake failure is still registered for reaping', async () => {
  const registry = new StdioProcessRegistry({
    // Report the pid as already gone so terminate() has nothing to wait on.
    kill: () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    },
    exitHooks: { on: () => {}, off: () => {} },
  });
  const createClient: CreateMcpClient = async (config) => {
    // The SDK sets transport.process when it spawns the child; mimic that, then fail the handshake so
    // this is a mid-handshake failure — the pid must still reach the registry via the finally.
    Object.assign(config.transport, { process: { pid: 4242 } });
    const c = fakeClient({});
    c.tools = async () => {
      throw new Error('handshake-boom');
    };
    return c;
  };

  const m = new McpClientManager({
    servers: { fs: { command: 'fs' } },
    createClient,
    processes: registry,
  });

  await m.connectAll();

  assert.equal(m.connected().length, 0);
  assert.deepEqual(
    registry.list().map((t) => ({ name: t.name, pid: t.pid })),
    [{ name: 'fs', pid: 4242 }],
  );
  await m.close();
});

test('connectAll: connectTimeoutMs <= 0 disables the deadline — a slow but successful connect completes', async () => {
  const createClient: CreateMcpClient = async () => {
    const c = fakeClient({});
    c.tools = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Same generic-return narrowing as fakeClient's, restated because this listing is replaced.
      return { slow: fakeTool() } as never;
    };
    return c;
  };
  const m = new McpClientManager({
    servers: { slow: { command: 'x' } },
    createClient,
    connectTimeoutMs: 0,
  });

  await m.connectAll();

  assert.deepEqual(Object.keys(m.toolsForRole('worker')), ['mcp__slow__slow']);
  await m.close();
});

test('connectAll warns on post-sanitization server name collisions (issue #80)', async () => {
  const { logger, warnings } = recordingLogger();
  const { createClient } = recordingFactory({
    'my.server': { ping: fakeTool() },
    'my server': { pong: fakeTool() },
    'my/server': { status: fakeTool() },
  });
  const m = new McpClientManager({
    servers: {
      'my.server': { command: 'a' },
      'my server': { command: 'b' },
      'my/server': { command: 'c' },
    },
    createClient,
    logger,
  });

  await m.connectAll();

  // All three servers should be connected (no deduping of the servers themselves).
  assert.equal(m.connected().length, 3);

  // But a warning should be issued about the post-sanitization collision.
  const collisionWarning = warnings.find(
    (w) => w.msg === 'mcp server name collision after sanitization',
  );
  assert.ok(collisionWarning, 'expected a collision warning');
  // All three original names should be listed.
  assert.deepEqual(collisionWarning?.fields?.colliding, ['my.server', 'my server', 'my/server']);
  // They should all sanitize to `my-server`.
  assert.equal(collisionWarning?.fields?.sanitized, 'my-server');

  await m.close();
});

test('connectAll: no collision warning when server names sanitize uniquely (issue #80)', async () => {
  const { logger, warnings } = recordingLogger();
  const { createClient } = recordingFactory({
    'my-server': { ping: fakeTool() },
    'other.srv': { pong: fakeTool() },
  });
  const m = new McpClientManager({
    servers: {
      'my-server': { command: 'a' },
      'other.srv': { command: 'b' },
    },
    createClient,
    logger,
  });

  await m.connectAll();

  // No collision warning should be issued when sanitized names are unique.
  const collisionWarning = warnings.find(
    (w) => w.msg === 'mcp server name collision after sanitization',
  );
  assert.equal(collisionWarning, undefined);

  await m.close();
});

test('mcpInitFrom: forwards the configured defer threshold, allowlist and logger (issue #339)', () => {
  // `mcpDeferToolsOver` is schema-defined, layer-merged with source tracking, and documented in
  // config.md and mcp.md with a default of 20 — and reached no manager at all, so setting it did
  // nothing. Both adapters hand-copied the field list; this is the one place that list now lives.
  const { logger } = recordingLogger();
  const init = mcpInitFrom(
    {
      mcpServers: { gh: { command: 'gh-mcp' } },
      mcpDeferToolsOver: 3,
      mcpRoleAllowlist: { worker: ['gh'] },
    },
    logger,
  );
  assert.equal(init.deferToolsOver, 3, 'the configured threshold reaches the manager');
  assert.deepEqual(init.servers, { gh: { command: 'gh-mcp' } });
  assert.deepEqual(init.roleAllowlist, { worker: ['gh'] });
  assert.equal(init.logger, logger);
});

test('mcpInitFrom: the threshold it forwards is the one toolSurfaceForRole honors (issue #339)', async () => {
  // Not just "the field is set": drive the manager built from it and prove the surface splits at the
  // configured number rather than the built-in default.
  const m = new McpClientManager({
    ...mcpInitFrom({ mcpServers: { gh: { command: 'gh-mcp' } }, mcpDeferToolsOver: 1 }),
    createClient: async () => fakeClient({ a: fakeTool(), b: fakeTool() }),
  });
  await m.connectAll();
  try {
    const surface = m.toolSurfaceForRole('worker');
    assert.deepEqual(Object.keys(surface.direct), [], '2 tools > threshold 1 → nothing direct');
    assert.equal(Object.keys(surface.deferred).length, 2, 'both defer');
  } finally {
    await m.close();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MCPClient, MCPClientConfig } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import type { LoggerLike } from '../logger/logger.ts';
import { type CreateMcpClient, McpClientManager } from './mcp-client.ts';

type FakeClient = MCPClient & {
  closeCalls: number;
  toolsValue: ToolSet;
};

type Recorded = { config: MCPClientConfig; name: string };

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
  return { description: 't', inputSchema: { type: 'object' } } as ToolSet[string];
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

test('server names are sanitized to the function-name charset in the namespace (issue #115)', async () => {
  const { createClient } = recordingFactory({ 'my server.v2': { ping: fakeTool() } });
  const m = new McpClientManager({
    servers: { 'my server.v2': { command: 'x' } },
    createClient,
  });
  await m.connectAll();
  // Spaces and dots → `-`.
  assert.deepEqual(Object.keys(m.toolsForRole('worker')), ['mcp__my-server-v2__ping']);
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

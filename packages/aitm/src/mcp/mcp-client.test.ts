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
  assert.deepEqual(Object.keys(tools).sort(), ['fs_read', 'http_get']);
});

test('toolsForRole respects roleAllowlist (filters by server name)', async () => {
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

  assert.deepEqual(Object.keys(m.toolsForRole('worker')), ['fs_read']);
  assert.deepEqual(Object.keys(m.toolsForRole('reviewer')), ['git_status']);
  // Unlisted role (planner) sees every server.
  assert.deepEqual(Object.keys(m.toolsForRole('planner')).sort(), ['fs_read', 'git_status', 'pay']);
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

test('toolsForRole warns and keeps the first occurrence on duplicate tool names', async () => {
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
  const firstTool = fakeTool();
  const secondTool = fakeTool();
  const { createClient } = recordingFactory({
    alpha: { shared: firstTool },
    beta: { shared: secondTool },
  });

  const m = new McpClientManager({
    servers: {
      alpha: { command: 'a' },
      beta: { command: 'b' },
    },
    createClient,
    logger,
  });
  await m.connectAll();
  const tools = m.toolsForRole('worker');

  assert.deepEqual(Object.keys(tools), ['shared']);
  assert.strictEqual(tools.shared, firstTool);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.msg, 'duplicate mcp tool name');
  assert.equal(warnings[0]?.fields?.tool, 'shared');
  assert.equal(warnings[0]?.fields?.server, 'beta');
  assert.equal(warnings[0]?.fields?.existingServer, 'alpha');
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

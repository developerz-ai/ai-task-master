import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpClientManager } from './mcp-client.ts';

test('McpClientManager is constructible (skeleton)', () => {
  const m = new McpClientManager({ servers: {} });
  assert.ok(m instanceof McpClientManager);
});

test('McpClientManager.connectAll throws until implemented', async () => {
  const m = new McpClientManager({ servers: {} });
  await assert.rejects(() => m.connectAll());
});

test('McpClientManager.toolsForRole throws until implemented', () => {
  const m = new McpClientManager({ servers: {} });
  assert.throws(() => m.toolsForRole('worker'));
});

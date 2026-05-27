import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServerSchema, McpServersSchema } from './schema.ts';

test('McpServerSchema accepts stdio shape (type omitted)', () => {
  const parsed = McpServerSchema.parse({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  });
  assert.equal('command' in parsed && parsed.command, 'npx');
});

test('McpServerSchema accepts http shape', () => {
  const parsed = McpServerSchema.parse({
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer xyz' },
  });
  assert.equal(parsed.type, 'http');
});

test('McpServerSchema accepts sse shape', () => {
  const parsed = McpServerSchema.parse({
    type: 'sse',
    url: 'https://example.com/sse',
  });
  assert.equal(parsed.type, 'sse');
});

test('McpServersSchema validates a record', () => {
  const parsed = McpServersSchema.parse({
    filesystem: { command: 'npx', args: ['-y', 'server-fs', '/tmp'] },
    api: { type: 'http', url: 'https://example.com/mcp' },
  });
  assert.equal(Object.keys(parsed).length, 2);
});

test('McpServerSchema rejects malformed URL', () => {
  assert.throws(() => McpServerSchema.parse({ type: 'http', url: 'not-a-url' }));
});

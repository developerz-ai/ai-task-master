import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpRoleAllowlistSchema, McpServerSchema, McpServersSchema } from './schema.ts';

test('McpRoleAllowlistSchema accepts array form, record form, and a mix; rejects bad shapes (issue #115)', () => {
  const parsed = McpRoleAllowlistSchema.parse({
    worker: ['filesystem', 'git'],
    planner: { filesystem: ['read_*', 'list_*'] },
  });
  assert.deepEqual(parsed.worker, ['filesystem', 'git']);
  assert.deepEqual(parsed.planner, { filesystem: ['read_*', 'list_*'] });
  assert.equal(parsed.reviewer, undefined, 'a role absent from the object stays undefined');
  // A record value must be string arrays, not bare strings; a role value must be array|record.
  assert.throws(() => McpRoleAllowlistSchema.parse({ worker: { filesystem: 'read_*' } }));
  assert.throws(() => McpRoleAllowlistSchema.parse({ worker: 5 }));
});

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

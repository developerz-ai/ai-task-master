import assert from 'node:assert/strict';
import { test } from 'node:test';
import { datetimeTool } from './datetime.ts';

test('datetimeTool has description', () => {
  const tool = datetimeTool();
  assert.ok(tool.description);
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 0);
});

test('datetimeTool inputSchema parses valid input', async () => {
  const tool = datetimeTool();
  assert.ok(tool.inputSchema);
  // Test with no timezone
  const result1 = await tool.inputSchema.parseAsync({});
  assert.deepEqual(result1, {});
  // Test with timezone
  const result2 = await tool.inputSchema.parseAsync({ timezone: 'America/New_York' });
  assert.deepEqual(result2, { timezone: 'America/New_York' });
});

test('datetimeTool execute returns datetime in ISO-8601 format and resolved timezone', async () => {
  const tool = datetimeTool();
  assert.ok(tool.execute);
  // Test without timezone (should resolve to UTC)
  const result1 = await tool.execute({});
  assert.ok(result1.datetime);
  assert.equal(typeof result1.datetime, 'string');
  assert.match(result1.datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO-8601 format
  assert.equal(typeof result1.timezone, 'string');
  assert.ok(result1.timezone.length > 0, 'timezone should be a resolved IANA timezone');
  // Test with timezone
  const result2 = await tool.execute({ timezone: 'America/Los_Angeles' });
  assert.ok(result2.datetime);
  assert.equal(typeof result2.datetime, 'string');
  assert.match(result2.datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO-8601 format
  assert.equal(result2.timezone, 'America/Los_Angeles');
});

test('datetimeTool rejects empty string timezone', async () => {
  const tool = datetimeTool();
  assert.ok(tool.inputSchema);
  await assert.rejects(
    () => tool.inputSchema.parseAsync({ timezone: '' }),
    /Invalid IANA timezone/,
  );
});

test('datetimeTool rejects unknown timezone', async () => {
  const tool = datetimeTool();
  assert.ok(tool.inputSchema);
  await assert.rejects(
    () => tool.inputSchema.parseAsync({ timezone: 'Atlantis/Lost' }),
    /Invalid IANA timezone/,
  );
});

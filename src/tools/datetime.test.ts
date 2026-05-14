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

test('datetimeTool execute returns datetime and timezone', async () => {
  const tool = datetimeTool();
  assert.ok(tool.execute);
  // Test without timezone
  const result1 = await tool.execute({});
  assert.ok(result1.datetime);
  assert.equal(typeof result1.datetime, 'string');
  assert.match(result1.datetime, /\d+\/\d+\/\d+/); // Basic date pattern MM/DD/YYYY
  assert.equal(result1.timezone, '');
  // Test with timezone
  const result2 = await tool.execute({ timezone: 'America/Los_Angeles' });
  assert.ok(result2.datetime);
  assert.equal(typeof result2.datetime, 'string');
  assert.match(result2.datetime, /\d+\/\d+\/\d+/); // Basic date pattern
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

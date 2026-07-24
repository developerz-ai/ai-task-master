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

test('datetimeTool execute returns localized datetime, UTC iso, and resolved timezone', async () => {
  const tool = datetimeTool();
  assert.ok(tool.execute);
  // Without a timezone, Intl resolves to the runtime's configured zone (not guaranteed UTC across
  // Bun/Node/Deno) — assert only that datetime is a non-empty string and iso is a UTC stamp.
  const result1 = await tool.execute({});
  assert.equal(typeof result1.datetime, 'string');
  assert.ok(result1.datetime.length > 0, 'datetime should be a non-empty localized string');
  assert.match(result1.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // UTC ISO-8601
  assert.equal(typeof result1.timezone, 'string');
  assert.ok(result1.timezone.length > 0, 'timezone should be a resolved IANA timezone');

  const laResult = await tool.execute({ timezone: 'America/Los_Angeles' });
  assert.equal(laResult.timezone, 'America/Los_Angeles');
  assert.match(laResult.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // Regression: `datetime` must be the same instant as `iso` rendered in the requested zone — the
  // pre-fix code returned `date.toISOString()` (UTC) here and only *labeled* it with the zone.
  const renderedInLa = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(new Date(laResult.iso));
  assert.equal(laResult.datetime, renderedInLa);

  // Two zones ~16-17h apart must render the same wall clock differently — proves the zone is
  // actually applied, not ignored (pre-fix both returned identical UTC ISO).
  const tokyoResult = await tool.execute({ timezone: 'Asia/Tokyo' });
  assert.equal(tokyoResult.timezone, 'Asia/Tokyo');
  assert.notEqual(laResult.datetime, tokyoResult.datetime);
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

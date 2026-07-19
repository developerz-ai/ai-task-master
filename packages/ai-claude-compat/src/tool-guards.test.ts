import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoSuchToolError, type Tool, type ToolCallRepairFunction, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import {
  DEFAULT_LOOP_BLOCK_AT,
  DEFAULT_LOOP_REMIND_AT,
  type LoopGuardVerdict,
  makeToolCallRepairer,
  resolveToolName,
  ToolCallLoopTracker,
  unknownToolMessage,
  withLoopGuard,
} from './tool-guards.ts';

// A tool whose model-visible text IS the string passed as `output`, so a render dials the base output.
function echoTool(): Tool {
  return tool({
    description: 'echo',
    inputSchema: z.object({}),
    execute: async () => '',
    toModelOutput: ({ output }) => ({ type: 'text', value: String(output) }),
  }) as Tool;
}

// A tool with NO custom toModelOutput → SDK default render (text for a string, json otherwise).
function defaultTool(): Tool {
  return tool({
    description: 'default',
    inputSchema: z.object({}),
    execute: async () => ({}),
  }) as Tool;
}

// Invoke a decorated tool's toModelOutput with a synthetic call. `input` matters — the loop guard
// hashes it — so callers vary it to control identity.
async function render(
  t: Tool,
  input: unknown,
  output: unknown,
): Promise<{ type: string; value?: unknown }> {
  const fn = t.toModelOutput;
  if (typeof fn !== 'function') throw new Error('tool has no toModelOutput');
  return (await fn({ toolCallId: 'c', input, output })) as { type: string; value?: unknown };
}

function messageOf(v: LoopGuardVerdict | undefined): string {
  assert.ok(v, 'verdict present');
  return v.action === 'allow' ? '' : v.message;
}

// ── escalation ladder ─────────────────────────────────────────────────────────────────────────

test('tool-guards: default ladder thresholds are 3 and 8', () => {
  assert.equal(DEFAULT_LOOP_REMIND_AT, 3);
  assert.equal(DEFAULT_LOOP_BLOCK_AT, 8);
});

test('tool-guards: identical calls escalate allow → remind → block along the ladder', () => {
  const tracker = new ToolCallLoopTracker();
  const verdicts: LoopGuardVerdict[] = [];
  for (let i = 0; i < 9; i++) verdicts.push(tracker.record('bash', { cmd: 'ls' }));

  assert.equal(verdicts[0]?.action, 'allow');
  assert.equal(verdicts[1]?.action, 'allow');
  assert.equal(verdicts[2]?.action, 'remind'); // 3rd → remindAt
  assert.match(messageOf(verdicts[2]), /identical input 3 times/);
  assert.match(messageOf(verdicts[2]), /`bash`/);

  assert.equal(verdicts[5]?.action, 'remind'); // still in the remind band
  assert.equal(verdicts[6]?.action, 'remind'); // 7th → blockAt-1 → final warning
  assert.match(messageOf(verdicts[6]), /final attempt/i);

  assert.equal(verdicts[7]?.action, 'block'); // 8th → blockAt
  assert.match(messageOf(verdicts[7]), /loop/i);
  assert.match(messageOf(verdicts[7]), /limit 8/);
  assert.equal(verdicts[8]?.action, 'block'); // stays blocked
  assert.equal(verdicts[8]?.action === 'block' ? verdicts[8].count : 0, 9);
});

test('tool-guards: object key order does not change call identity', () => {
  const tracker = new ToolCallLoopTracker({ remindAt: 2, blockAt: 5 });
  assert.equal(tracker.record('edit', { a: 1, b: 2 }).action, 'allow');
  // Same input, keys reordered + nested → canonicalized to the same identity → 2nd call reminds.
  assert.equal(tracker.record('edit', { b: 2, a: 1 }).action, 'remind');
});

test('tool-guards: array order stays significant', () => {
  const tracker = new ToolCallLoopTracker({ remindAt: 2, blockAt: 5 });
  assert.equal(tracker.record('run', { steps: [1, 2] }).action, 'allow');
  assert.equal(tracker.record('run', { steps: [2, 1] }).action, 'allow'); // different sequence
});

test('tool-guards: distinct inputs and distinct tools are counted independently', () => {
  const tracker = new ToolCallLoopTracker({ remindAt: 2, blockAt: 5 });
  assert.equal(tracker.record('bash', { cmd: 'ls' }).action, 'allow');
  assert.equal(tracker.record('bash', { cmd: 'pwd' }).action, 'allow'); // different input
  assert.equal(tracker.record('grep', { cmd: 'ls' }).action, 'allow'); // different tool, same input
});

test('tool-guards: reset clears the counts', () => {
  const tracker = new ToolCallLoopTracker({ remindAt: 2, blockAt: 5 });
  tracker.record('bash', { cmd: 'ls' });
  assert.equal(tracker.record('bash', { cmd: 'ls' }).action, 'remind');
  tracker.reset();
  assert.equal(tracker.record('bash', { cmd: 'ls' }).action, 'allow');
});

test('tool-guards: custom thresholds are honored', () => {
  const tracker = new ToolCallLoopTracker({ remindAt: 2, blockAt: 3 });
  assert.equal(tracker.record('x', {}).action, 'allow');
  assert.equal(tracker.record('x', {}).action, 'remind');
  assert.equal(tracker.record('x', {}).action, 'block');
});

test('tool-guards: invalid thresholds throw', () => {
  assert.throws(() => new ToolCallLoopTracker({ remindAt: 0 }), RangeError);
  assert.throws(() => new ToolCallLoopTracker({ remindAt: 5, blockAt: 5 }), RangeError);
  assert.throws(() => new ToolCallLoopTracker({ remindAt: 3, blockAt: 2 }), RangeError);
});

// ── decorator wiring ──────────────────────────────────────────────────────────────────────────

test('tool-guards: withLoopGuard preserves execute bit-for-bit', () => {
  const original = echoTool();
  const { tools } = withLoopGuard({ echo: original });
  assert.equal(tools.echo.execute, original.execute);
});

test('tool-guards: below remindAt the base output is unchanged', async () => {
  const { tools } = withLoopGuard({ echo: echoTool() }, { remindAt: 3, blockAt: 8 });
  const first = await render(tools.echo, { cmd: 'ls' }, 'output-1');
  assert.deepEqual(first, { type: 'text', value: 'output-1' });
});

test('tool-guards: at remindAt a reminder is PREPENDED before the base text', async () => {
  const { tools } = withLoopGuard({ echo: echoTool() }, { remindAt: 3, blockAt: 8 });
  await render(tools.echo, { cmd: 'ls' }, 'base');
  await render(tools.echo, { cmd: 'ls' }, 'base');
  const third = await render(tools.echo, { cmd: 'ls' }, 'base');

  assert.equal(third.type, 'text');
  const value = String(third.value);
  assert.match(value, /<system-reminder>/);
  assert.match(value, /identical input 3 times/);
  // Reminder comes first, base text after it.
  assert.ok(value.indexOf('system-reminder') < value.indexOf('base'), 'reminder precedes base');
  assert.ok(value.endsWith('base'), 'base output preserved after the reminder');
});

test('tool-guards: at blockAt the result becomes an error-text refusal', async () => {
  const { tools } = withLoopGuard({ echo: echoTool() }, { remindAt: 2, blockAt: 3 });
  await render(tools.echo, { cmd: 'ls' }, 'base');
  await render(tools.echo, { cmd: 'ls' }, 'base');
  const blocked = await render(tools.echo, { cmd: 'ls' }, 'base');

  assert.equal(blocked.type, 'error-text');
  assert.match(String(blocked.value), /blocked/);
  assert.match(String(blocked.value), /do not repeat/i);
});

test('tool-guards: a reminder on a non-text base yields a content result with the reminder first', async () => {
  const { tools } = withLoopGuard({ read: defaultTool() }, { remindAt: 2, blockAt: 8 });
  await render(tools.read, { path: 'a' }, { body: 'x' });
  const reminded = await render(tools.read, { path: 'a' }, { body: 'x' });

  assert.equal(reminded.type, 'content');
  const parts = (reminded as { value: Array<{ type: string; text?: string }> }).value;
  assert.equal(parts[0]?.type, 'text');
  assert.match(String(parts[0]?.text), /<system-reminder>/);
  assert.match(String(parts[1]?.text), /"body":"x"/); // base json rendered after the reminder
});

test('tool-guards: the decorator reset() clears per-conversation counts', async () => {
  const { tools, reset } = withLoopGuard({ echo: echoTool() }, { remindAt: 2, blockAt: 8 });
  await render(tools.echo, { cmd: 'ls' }, 'base');
  const reminded = await render(tools.echo, { cmd: 'ls' }, 'base');
  assert.match(String(reminded.value), /<system-reminder>/);
  reset();
  const fresh = await render(tools.echo, { cmd: 'ls' }, 'base');
  assert.deepEqual(fresh, { type: 'text', value: 'base' });
});

// ── tool-call repair ──────────────────────────────────────────────────────────────────────────

const AVAILABLE = ['readFile', 'writeFile', 'bash', 'grep'];

test('tool-guards: an exact name resolves to itself', () => {
  assert.deepEqual(resolveToolName('readFile', AVAILABLE), {
    kind: 'resolved',
    toolName: 'readFile',
  });
});

test('tool-guards: a case-only mismatch is repaired', () => {
  assert.deepEqual(resolveToolName('ReadFile', AVAILABLE), {
    kind: 'resolved',
    toolName: 'readFile',
  });
  assert.deepEqual(resolveToolName('BASH', AVAILABLE), { kind: 'resolved', toolName: 'bash' });
});

test('tool-guards: a separator mismatch is repaired', () => {
  assert.deepEqual(resolveToolName('read_file', AVAILABLE), {
    kind: 'resolved',
    toolName: 'readFile',
  });
  assert.deepEqual(resolveToolName('read-file', AVAILABLE), {
    kind: 'resolved',
    toolName: 'readFile',
  });
  assert.deepEqual(resolveToolName('WRITE FILE', AVAILABLE), {
    kind: 'resolved',
    toolName: 'writeFile',
  });
});

test('tool-guards: an alias table takes precedence over fuzzy matching', () => {
  const aliases = { str_replace_editor: 'writeFile', Bash: 'bash' };
  assert.deepEqual(resolveToolName('str_replace_editor', AVAILABLE, aliases), {
    kind: 'resolved',
    toolName: 'writeFile',
  });
  // Alias key matched case-insensitively.
  assert.deepEqual(resolveToolName('bAsH', AVAILABLE, aliases), {
    kind: 'resolved',
    toolName: 'bash',
  });
});

test('tool-guards: a stale alias (target absent) falls through to unknown', () => {
  const res = resolveToolName('foo', AVAILABLE, { foo: 'nonexistent' });
  assert.equal(res.kind, 'unknown');
});

test('tool-guards: an ambiguous shape match is not guessed', () => {
  // Both normalize to "readfile"; neither is an exact/case hit for "readfile" → ambiguous → unknown.
  const res = resolveToolName('readfile', ['read_file', 'read-file']);
  assert.equal(res.kind, 'unknown');
});

test('tool-guards: a truly unknown name returns a structured, sorted message', () => {
  const res = resolveToolName('frobnicate', AVAILABLE);
  assert.equal(res.kind, 'unknown');
  if (res.kind === 'unknown') {
    assert.match(res.message, /unknown tool "frobnicate"/);
    assert.match(res.message, /Available tools: bash, grep, readFile, writeFile/); // sorted
  }
});

test('tool-guards: unknownToolMessage handles an empty tool set', () => {
  assert.match(unknownToolMessage('x', []), /\(none available\)/);
});

// ── repairer adapter ──────────────────────────────────────────────────────────────────────────

async function callRepair(
  repair: ToolCallRepairFunction<ToolSet>,
  toolName: string,
  tools: ToolSet,
): Promise<{ toolName: string; toolCallId: string; input: string } | null> {
  const fixed = await repair({
    system: undefined,
    messages: [],
    toolCall: { type: 'tool-call', toolCallId: 'c1', toolName, input: '{"path":"a"}' },
    tools,
    inputSchema: async () => ({}),
    error: new NoSuchToolError({ toolName, availableTools: Object.keys(tools) }),
  });
  return fixed;
}

test('tool-guards: the repairer corrects a near-miss name, preserving id and input', async () => {
  const tools: ToolSet = { readFile: echoTool() };
  const fixed = await callRepair(makeToolCallRepairer(), 'read_file', tools);
  assert.ok(fixed);
  assert.equal(fixed.toolName, 'readFile');
  assert.equal(fixed.toolCallId, 'c1');
  assert.equal(fixed.input, '{"path":"a"}');
});

test('tool-guards: the repairer applies the alias table', async () => {
  const tools: ToolSet = { writeFile: echoTool() };
  const fixed = await callRepair(
    makeToolCallRepairer({ aliases: { str_replace_editor: 'writeFile' } }),
    'str_replace_editor',
    tools,
  );
  assert.equal(fixed?.toolName, 'writeFile');
});

test('tool-guards: the repairer returns null when there is nothing to fix', async () => {
  const tools: ToolSet = { readFile: echoTool() };
  assert.equal(await callRepair(makeToolCallRepairer(), 'readFile', tools), null); // exact match
  assert.equal(await callRepair(makeToolCallRepairer(), 'frobnicate', tools), null); // truly unknown
});

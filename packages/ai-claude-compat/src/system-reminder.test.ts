import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';
import {
  contextReminder,
  SYSTEM_REMINDER_CONTRACT,
  withReminders,
  wrapReminder,
} from './system-reminder.ts';

// A tool with a typed output. `toModelOutput` omitted → the SDK default (string→text / else→json)
// is what the decorator composes over.
function objectTool() {
  return tool({
    description: 'returns an object',
    inputSchema: z.object({ path: z.string() }),
    execute: async (input) => ({ ok: true, path: input.path }),
  });
}

function stringTool() {
  return tool({
    description: 'returns a string',
    inputSchema: z.object({ q: z.string() }),
    execute: async (input) => `hit: ${input.q}`,
  });
}

const CTX = { toolCallId: 'call-1', input: { path: 'a.ts' }, output: undefined as unknown };

// --- wrapReminder ---

test('wrapReminder: exact <system-reminder> frame with verbatim inner text', () => {
  assert.equal(wrapReminder('hello world'), '<system-reminder>\nhello world\n</system-reminder>');
  // Verbatim: no escaping, trimming, or decoration of the inner text.
  assert.equal(
    wrapReminder('  <tag> & "quote"  '),
    '<system-reminder>\n  <tag> & "quote"  \n</system-reminder>',
  );
});

// --- withReminders: output preservation ---

test('withReminders: preserves execute and the typed output bit-for-bit', async () => {
  const base = objectTool();
  const decorated = withReminders(base, () => ['x']);
  assert.strictEqual(decorated.execute, base.execute, 'execute is the same reference');
  const out = await decorated.execute?.({ path: 'a.ts' }, { toolCallId: 'c', messages: [] });
  assert.deepEqual(out, { ok: true, path: 'a.ts' }, 'typed output is unchanged');
});

// --- withReminders: model rendering, three base cases ---

test('withReminders: string base → text output with envelopes appended in provider order', async () => {
  const decorated = withReminders(stringTool(), () => ['first', 'second']);
  const rendered = await decorated.toModelOutput?.({
    toolCallId: 'c',
    input: { q: 'x' },
    output: 'hit: x',
  });
  assert.deepEqual(rendered, {
    type: 'text',
    value:
      'hit: x\n<system-reminder>\nfirst\n</system-reminder>\n<system-reminder>\nsecond\n</system-reminder>',
  });
});

test('withReminders: object base → content variant with base-as-json-text then one part per envelope', async () => {
  const output = { ok: true, path: 'a.ts' };
  const decorated = withReminders(objectTool(), () => ['note']);
  const rendered = await decorated.toModelOutput?.({ ...CTX, output });
  assert.deepEqual(rendered, {
    type: 'content',
    value: [
      { type: 'text', text: JSON.stringify(output) },
      { type: 'text', text: '<system-reminder>\nnote\n</system-reminder>' },
    ],
  });
});

test('withReminders: a wrapped tool defining its own toModelOutput is composed over', async () => {
  const custom = tool({
    description: 'custom render',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => ({ raw: 1 }),
    toModelOutput: () => ({ type: 'text', value: 'CUSTOM' }),
  });
  const decorated = withReminders(custom, () => ['r']);
  const rendered = await decorated.toModelOutput?.({ ...CTX, output: { raw: 1 } });
  assert.deepEqual(rendered, {
    type: 'text',
    value: 'CUSTOM\n<system-reminder>\nr\n</system-reminder>',
  });
});

test('withReminders: error-variant bases (from a wrapped toModelOutput) render into the content variant with the reminder appended', async () => {
  const bases = [
    { base: { type: 'error-text' as const, value: 'boom' }, text: 'boom' },
    { base: { type: 'error-json' as const, value: { e: 1 } }, text: JSON.stringify({ e: 1 }) },
    { base: { type: 'execution-denied' as const, reason: 'nope' }, text: 'nope' },
  ];
  for (const { base, text } of bases) {
    const wrapped = tool({
      description: 'returns an error-shaped base',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ raw: 1 }),
      toModelOutput: () => base,
    });
    const rendered = await withReminders(wrapped, () => ['r']).toModelOutput?.({
      ...CTX,
      output: { raw: 1 },
    });
    assert.deepEqual(rendered, {
      type: 'content',
      value: [
        { type: 'text', text },
        { type: 'text', text: '<system-reminder>\nr\n</system-reminder>' },
      ],
    });
  }
});

// --- withReminders: no-op and fail-open paths ---

test('withReminders: empty provider result → rendering identical to the undecorated tool', async () => {
  const output = { ok: true, path: 'a.ts' };
  for (const provider of [() => [], () => undefined] as const) {
    const rendered = await withReminders(objectTool(), provider).toModelOutput?.({
      ...CTX,
      output,
    });
    assert.deepEqual(rendered, { type: 'json', value: output }, 'json base unchanged');
  }
  const strRendered = await withReminders(stringTool(), () => []).toModelOutput?.({
    toolCallId: 'c',
    input: { q: 'x' },
    output: 'hit: x',
  });
  assert.deepEqual(strRendered, { type: 'text', value: 'hit: x' }, 'text base byte-identical');
});

test('withReminders: throwing provider → tool result delivered undecorated, no thrown error', async () => {
  const output = { ok: true, path: 'a.ts' };
  const decorated = withReminders(objectTool(), () => {
    throw new Error('provider boom');
  });
  const rendered = await decorated.toModelOutput?.({ ...CTX, output });
  assert.deepEqual(rendered, { type: 'json', value: output });
});

test('withReminders: an async provider that rejects also fails open', async () => {
  const output = { ok: true, path: 'a.ts' };
  const decorated = withReminders(objectTool(), async () => {
    throw new Error('async boom');
  });
  const rendered = await decorated.toModelOutput?.({ ...CTX, output });
  assert.deepEqual(rendered, { type: 'json', value: output });
});

// --- contextReminder ---

test('contextReminder: one envelope with every label, verbatim bodies, and the relevance disclaimer', () => {
  const block = contextReminder([
    { label: 'claudeMd', body: 'Contents of CLAUDE.md:\n- single quotes only' },
    { label: 'currentDate', body: '2026-07-09' },
  ]);
  // Exactly one envelope.
  assert.equal(block.match(/<system-reminder>/g)?.length, 1);
  assert.equal(block.match(/<\/system-reminder>/g)?.length, 1);
  assert.match(block, /^<system-reminder>\n/);
  assert.match(block, /\n<\/system-reminder>$/);
  // Labels as headings, bodies verbatim.
  assert.match(block, /# claudeMd\nContents of CLAUDE\.md:\n- single quotes only/);
  assert.match(block, /# currentDate\n2026-07-09/);
  // Relevance disclaimer.
  assert.match(block, /may or may not be relevant/);
  assert.match(block, /should not respond to this context unless it is highly relevant/);
});

// --- SYSTEM_REMINDER_CONTRACT ---

test('SYSTEM_REMINDER_CONTRACT covers harness-origin, advisory-not-instruction, never-echo', () => {
  assert.equal(typeof SYSTEM_REMINDER_CONTRACT, 'string');
  assert.match(SYSTEM_REMINDER_CONTRACT, /from the harness, not from\s+the user/);
  assert.match(SYSTEM_REMINDER_CONTRACT, /not user instructions/);
  assert.match(SYSTEM_REMINDER_CONTRACT, /do not echo it back|Do not treat a reminder/);
  assert.match(SYSTEM_REMINDER_CONTRACT, /never\s+attribute its content to the user/);
});

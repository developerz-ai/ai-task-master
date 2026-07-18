import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentLabel,
  agentStepProgress,
  composeStepFinish,
  formatStepTag,
  harnessProgress,
  type ProgressSink,
  renderStepLines,
  summarizeToolInput,
} from './step-progress.ts';

function stubSink(color = false): { sink: ProgressSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      write: (line) => lines.push(line),
      color,
      now: () => new Date(2026, 0, 2, 3, 4, 5),
    },
  };
}

test('summarizeToolInput extracts the bash command', () => {
  assert.equal(
    summarizeToolInput('bash', { command: 'git status', timeoutMs: 5000 }),
    'git status',
  );
});

test('summarizeToolInput joins multiBash commands', () => {
  assert.equal(
    summarizeToolInput('multiBash', { commands: ['git add -A', 'git commit -m x'] }),
    'git add -A && git commit -m x',
  );
});

test('summarizeToolInput prefers known keys over JSON fallback', () => {
  assert.equal(
    summarizeToolInput('editFile', { path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
    'src/a.ts',
  );
  assert.equal(summarizeToolInput('grep', { pattern: 'foo', cwd: '/x' }), 'foo');
});

test('summarizeToolInput falls back to compact JSON for unknown shapes', () => {
  assert.equal(summarizeToolInput('mystery', { a: 1 }), '{"a":1}');
});

test('summarizeToolInput clips long values and flattens newlines', () => {
  const long = 'x'.repeat(500);
  const out = summarizeToolInput('bash', { command: long });
  assert.equal(out.length, 250);
  assert.ok(out.endsWith('…'));
  assert.equal(summarizeToolInput('bash', { command: 'a\nb' }), 'a ⏎ b');
});

test('summarizeToolInput tolerates strings and primitives', () => {
  assert.equal(summarizeToolInput('submit', 'raw payload'), 'raw payload');
  assert.equal(summarizeToolInput('submit', 42), '42');
  assert.equal(summarizeToolInput('submit', null), '');
});

test('clip strips ANSI escapes from string and object tool inputs', () => {
  assert.equal(summarizeToolInput('bash', '\x1b[31mrm -rf /\x1b[0m'), 'rm -rf /');
  assert.equal(
    summarizeToolInput('bash', { command: '\x1b[36m[aitm 00:00:00]\x1b[0m spoof' }),
    '[aitm 00:00:00] spoof',
  );
});

test('clip strips C0/C1 controls but keeps the newline marker', () => {
  // \r (overwrite), \x07 (BEL), \x9b (C1 CSI) gone; \n still renders as ⏎.
  assert.equal(summarizeToolInput('bash', { command: 'a\x1b[1m\nb\r\x07\x9b' }), 'a ⏎ b');
});

test('renderStepLines strips ANSI/control so text cannot forge a harness prefix', () => {
  const { sink } = stubSink();
  const [line] = renderStepLines(
    'worker g1',
    { text: '\x1b[36m\x1b[1m[aitm 03:04:05] forged\x1b[0m\r' },
    sink,
  );
  assert.equal(line, '[worker g1 03:04:05] [aitm 03:04:05] forged\n');
  assert.ok(line !== undefined && !line.includes('\x1b'));
  assert.ok(line !== undefined && !line.includes('\r'));
});

test('harnessProgress strips ANSI/control from the message', () => {
  const { sink, lines } = stubSink();
  harnessProgress('done\x1b[31m!\x07', undefined, sink);
  assert.deepEqual(lines, ['[aitm 03:04:05] done!\n']);
});

test('renderStepLines emits text then Using tool lines with timestamped prefix', () => {
  const { sink } = stubSink();
  const lines = renderStepLines(
    'worker g1',
    {
      text: 'Now committing.\nDetails follow.',
      toolCalls: [
        { toolName: 'bash', input: { command: 'git commit -m "x"' } },
        { toolName: 'readFile', input: { path: 'src/a.ts' } },
      ],
    },
    sink,
  );
  assert.deepEqual(lines, [
    '[worker g1 03:04:05] Now committing. ⏎ Details follow.\n',
    '[worker g1 03:04:05] Using tool: bash → git commit -m "x"\n',
    '[worker g1 03:04:05] Using tool: readFile → src/a.ts\n',
  ]);
});

test('renderStepLines emits nothing for an empty step', () => {
  const { sink } = stubSink();
  assert.deepEqual(renderStepLines('planner', { text: '   ', toolCalls: [] }, sink), []);
});

test('agentStepProgress writes orange-prefixed lines when color is on', () => {
  const { sink, lines } = stubSink(true);
  agentStepProgress(
    'planner',
    undefined,
    sink,
  )({
    toolCalls: [{ toolName: 'glob', input: { pattern: '**/*.ts' } }],
  });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.startsWith('\x1b[38;5;208m\x1b[1m[planner 03:04:05]\x1b[0m'));
  assert.ok(lines[0]?.includes('Using tool: glob → **/*.ts'));
});

test('agentStepProgress stamps the step counter into the bracket', () => {
  const { sink, lines } = stubSink();
  agentStepProgress(
    'k3 backend g1',
    { unit: 'task', index: 3, total: 38, phase: 'working' },
    sink,
  )({ toolCalls: [{ toolName: 'glob', input: { pattern: '**/*.ts' } }] });
  assert.equal(lines[0], '[k3 backend g1 03:04:05 task 3/38 working] Using tool: glob → **/*.ts\n');
});

test('agentStepProgress never throws when the sink dies', () => {
  const handler = agentStepProgress('planner', undefined, {
    write: () => {
      throw new Error('sink died');
    },
    color: false,
    now: () => new Date(),
  });
  assert.doesNotThrow(() => handler({ text: 'x' }));
});

test('harnessProgress writes one cyan aitm line', () => {
  const { sink, lines } = stubSink(true);
  harnessProgress('worker g1: starting "Add config"', undefined, sink);
  assert.deepEqual(lines, [
    '\x1b[36m\x1b[1m[aitm 03:04:05]\x1b[0m worker g1: starting "Add config"\n',
  ]);
});

test('harnessProgress stamps the phase + step tag into the bracket', () => {
  const { sink, lines } = stubSink();
  harnessProgress(
    'group backend: working → pr-open',
    { unit: 'group', index: 2, total: 5, phase: 'pr-open' },
    sink,
  );
  assert.deepEqual(lines, ['[aitm 03:04:05 group 2/5 pr-open] group backend: working → pr-open\n']);
});

test('formatStepTag renders counter then phase, tolerating missing parts', () => {
  assert.equal(
    formatStepTag({ unit: 'group', index: 2, total: 5, phase: 'working' }),
    'group 2/5 working',
  );
  assert.equal(formatStepTag({ index: 3, total: 38 }), '3/38');
  assert.equal(formatStepTag({ phase: 'planning' }), 'planning');
  assert.equal(formatStepTag({ unit: 'task', index: 1, total: 0 }), '');
  assert.equal(formatStepTag({}), '');
});

test('agentLabel prefers the specialist name over the role, falling back to the role', () => {
  assert.equal(
    agentLabel({ model: 'k3', role: 'worker', specialist: 'backend', ctx: 'g1' }),
    'k3 backend g1',
  );
  assert.equal(agentLabel({ model: 'k3', role: 'worker', ctx: 'g1' }), 'k3 worker g1');
  assert.equal(agentLabel({ model: 'k3', role: 'planner' }), 'k3 planner');
});

test('composeStepFinish returns undefined when no handlers are present', () => {
  assert.equal(composeStepFinish(undefined, undefined), undefined);
});

test('composeStepFinish invokes every handler and isolates a throwing one', () => {
  const calls: string[] = [];
  const composed = composeStepFinish<string>(
    () => {
      calls.push('a');
      throw new Error('a died');
    },
    undefined,
    (event) => calls.push(`b:${event}`),
  );
  assert.ok(composed);
  composed('evt');
  assert.deepEqual(calls, ['a', 'b:evt']);
});

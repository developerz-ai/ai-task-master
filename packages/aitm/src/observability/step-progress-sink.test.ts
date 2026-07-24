import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentLabel } from './step-progress-format.ts';
import {
  agentStepProgress,
  composeStepFinish,
  harnessProgress,
  type ProgressSink,
} from './step-progress-sink.ts';

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

test('harnessProgress redacts credentials in a harness message', () => {
  const { sink, lines } = stubSink();
  harnessProgress('pushing to https://user:hunter2@github.com/org/repo.git', undefined, sink);
  assert.deepEqual(lines, [
    '[aitm 03:04:05] pushing to https://[REDACTED]github.com/org/repo.git\n',
  ]);
});

test('harnessProgress strips ANSI/control from the message', () => {
  const { sink, lines } = stubSink();
  harnessProgress('done\x1b[31m!\x07', undefined, sink);
  assert.deepEqual(lines, ['[aitm 03:04:05] done!\n']);
});

test('harnessProgress milestone: a ★ leads the line, and it goes green under color', () => {
  // The one event the operator waits for (a group merged) must be scannable in a wall of cyan lines.
  const plain = stubSink(false);
  harnessProgress('group g1: reviewing → merged — done in 8m', undefined, plain.sink, {
    milestone: true,
  });
  assert.deepEqual(plain.lines, ['[aitm 03:04:05] ★ group g1: reviewing → merged — done in 8m\n']);

  const colored = stubSink(true);
  harnessProgress('group g1: merged', undefined, colored.sink, { milestone: true });
  const line = colored.lines[0] ?? '';
  assert.ok(line.includes('★'), 'the star is present');
  assert.ok(line.includes('\x1b[32m'), 'the line uses the green SGR code');
  assert.ok(!line.includes('\x1b[36m'), 'not the cyan default');
});

test('harnessProgress: a non-milestone line stays cyan with no star', () => {
  const colored = stubSink(true);
  harnessProgress('group g1: working', undefined, colored.sink);
  const line = colored.lines[0] ?? '';
  assert.ok(line.includes('\x1b[36m'), 'cyan default');
  assert.ok(!line.includes('★'), 'no milestone star');
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
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '\n');
  assert.ok(
    lines[1]?.startsWith(
      '\x1b[38;5;208m\x1b[1m[planner \x1b[2m03:04:05\x1b[0m\x1b[38;5;208m\x1b[1m]\x1b[0m',
    ),
  );
  assert.ok(lines[1]?.includes('Using tool: glob → **/*.ts'));
});

test('agentStepProgress stamps the step counter into the bracket', () => {
  const { sink, lines } = stubSink();
  agentStepProgress(
    'k3 backend g1',
    { unit: 'task', index: 3, total: 38, phase: 'working' },
    sink,
  )({ toolCalls: [{ toolName: 'glob', input: { pattern: '**/*.ts' } }] });
  assert.equal(lines[1], '[k3 backend g1 task 3/38 working 03:04:05] Using tool: glob → **/*.ts\n');
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
    '\x1b[36m\x1b[1m[aitm \x1b[2m03:04:05\x1b[0m\x1b[36m\x1b[1m]\x1b[0m worker g1: starting "Add config"\n',
  ]);
});

test('harnessProgress stamps the phase + step tag into the bracket', () => {
  const { sink, lines } = stubSink();
  harnessProgress(
    'group backend: working → pr-open',
    { unit: 'group', index: 2, total: 5, phase: 'pr-open' },
    sink,
  );
  assert.deepEqual(lines, ['[aitm group 2/5 pr-open 03:04:05] group backend: working → pr-open\n']);
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

test('agentStepProgress with textAndTools:false renders only the reasoning line', () => {
  const { sink, lines } = stubSink();
  agentStepProgress('worker g1', undefined, sink, { textAndTools: false })({
    reasoningText: 'weighing options',
    text: 'done',
    toolCalls: [{ toolName: 'bash', input: { command: 'git status' } }],
  });
  assert.deepEqual(lines, ['\n', '[worker g1 03:04:05] thinking: weighing options\n']);
});

test('agentStepProgress with textAndTools:false emits nothing when there is no reasoning', () => {
  const { sink, lines } = stubSink();
  agentStepProgress('worker g1', undefined, sink, { textAndTools: false })({
    text: 'done',
    toolCalls: [{ toolName: 'bash', input: {} }],
  });
  assert.deepEqual(lines, []);
});

test('a structured AgentLabel colors the subagent name blue, the tag magenta, the time dim', () => {
  const { sink, lines } = stubSink(true);
  agentStepProgress(
    agentLabel({ model: 'k3', role: 'editor', file: 'src/auth.ts', ctx: 'g1' }),
    { unit: 'task', index: 3, total: 4, phase: 'working' },
    sink,
  )({ toolCalls: [{ toolName: 'bash', input: { command: 'ls' } }] });
  const line = lines[1] ?? '';
  const orange = '\x1b[38;5;208m\x1b[1m';
  assert.ok(line.includes(`k3 \x1b[34m\x1b[1meditor:auth.ts\x1b[0m${orange} g1`), 'name is blue');
  assert.ok(line.includes(`\x1b[35mtask 3/4 working\x1b[0m${orange}`), 'state tag is magenta');
  assert.ok(line.includes(`\x1b[2m03:04:05\x1b[0m${orange}]`), 'timestamp is dim, at the end');
});

test('a structured AgentLabel renders as plain text when color is off (non-TTY)', () => {
  const { sink, lines } = stubSink();
  agentStepProgress(
    agentLabel({ model: 'k3', role: 'worker', ctx: 'g1' }),
    { phase: 'working' },
    sink,
  )({ toolCalls: [{ toolName: 'bash', input: { command: 'ls' } }] });
  assert.equal(lines[1], '[k3 worker g1 working 03:04:05] Using tool: bash → ls\n');
});

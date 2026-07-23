import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  agentLabel,
  agentStepProgress,
  composeStepFinish,
  createLiveStreamRenderer,
  formatDuration,
  formatStepTag,
  harnessProgress,
  labelText,
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

test('summarizeToolInput rewrites an absolute file_path/path cwd-relative', () => {
  const abs = join(process.cwd(), 'src', 'a.ts');
  assert.equal(summarizeToolInput('editFile', { file_path: abs }), join('src', 'a.ts'));
  assert.equal(summarizeToolInput('readFile', { path: abs }), join('src', 'a.ts'));
});

test('summarizeToolInput leaves an already-relative path untouched', () => {
  assert.equal(summarizeToolInput('readFile', { path: 'src/a.ts' }), 'src/a.ts');
});

test('summarizeToolInput caps file_path/path/pattern at 120, not the 250 command cap', () => {
  const longPath = `src/${'x'.repeat(200)}.ts`;
  const out = summarizeToolInput('readFile', { path: longPath });
  assert.equal(out.length, 120);
  assert.ok(out.endsWith('…'));
  const longPattern = 'x'.repeat(200);
  const patternOut = summarizeToolInput('grep', { pattern: longPattern });
  assert.equal(patternOut.length, 120);
});

test('summarizeToolInput does not relativize a grep/glob pattern', () => {
  assert.equal(
    summarizeToolInput('grep', { pattern: '/abs/looking/pattern' }),
    '/abs/looking/pattern',
  );
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
  const lines = renderStepLines(
    'worker g1',
    { text: '\x1b[36m\x1b[1m[aitm 03:04:05] forged\x1b[0m\r' },
    sink,
  );
  assert.deepEqual(lines, ['\n', '[worker g1 03:04:05] [aitm 03:04:05] forged\n']);
  assert.ok(!lines.some((l) => l.includes('\x1b')));
  assert.ok(!lines.some((l) => l.includes('\r')));
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

test('renderStepLines emits text then Using tool lines with timestamped prefix, blank line before each section', () => {
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
    '\n',
    '[worker g1 03:04:05] Now committing. ⏎ Details follow.\n',
    '\n',
    '[worker g1 03:04:05] Using tool: bash → git commit -m "x"\n',
    '[worker g1 03:04:05] Using tool: readFile → src/a.ts\n',
  ]);
});

test('renderStepLines emits nothing for an empty step', () => {
  const { sink } = stubSink();
  assert.deepEqual(renderStepLines('planner', { text: '   ', toolCalls: [] }, sink), []);
});

test('renderStepLines never emits two consecutive blank lines even with reasoning + text + tools', () => {
  const { sink } = stubSink();
  const lines = renderStepLines(
    'worker g1',
    {
      reasoningText: 'weighing options',
      text: 'Committing now.',
      toolCalls: [{ toolName: 'bash', input: { command: 'git status' } }],
    },
    sink,
  );
  const consecutiveBlanks = lines.some((line, i) => line === '\n' && lines[i - 1] === '\n');
  assert.equal(consecutiveBlanks, false);
  assert.equal(lines.filter((l) => l === '\n').length, 3);
});

test('renderStepLines renders reasoning dim, clipped to 200, prefixed thinking:, before the text line', () => {
  const { sink, lines } = (() => {
    const s = stubSink(true);
    return {
      sink: s.sink,
      lines: renderStepLines('worker g1', { reasoningText: 'a'.repeat(300) }, s.sink),
    };
  })();
  assert.deepEqual(lines, [
    '\n',
    `\x1b[2m[worker g1 03:04:05] thinking: ${'a'.repeat(199)}…\x1b[0m\n`,
  ]);
  void sink;
});

test('renderStepLines orders reasoning before text before tool calls', () => {
  const { sink } = stubSink();
  const lines = renderStepLines(
    'worker g1',
    {
      reasoningText: 'thinking it through',
      text: 'done',
      toolCalls: [{ toolName: 'bash', input: {} }],
    },
    sink,
  );
  assert.deepEqual(lines, [
    '\n',
    '[worker g1 03:04:05] thinking: thinking it through\n',
    '\n',
    '[worker g1 03:04:05] done\n',
    '\n',
    '[worker g1 03:04:05] Using tool: bash → {}\n',
  ]);
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
    agentLabel({ model: 'k3', role: 'worker', specialist: 'backend', ctx: 'g1' }).text,
    'k3 backend g1',
  );
  assert.equal(agentLabel({ model: 'k3', role: 'worker', ctx: 'g1' }).text, 'k3 worker g1');
  assert.equal(agentLabel({ model: 'k3', role: 'planner' }).text, 'k3 planner');
});

test('agentLabel renders an editor:<basename> name when a file is given, taking priority over specialist', () => {
  assert.equal(
    agentLabel({ model: 'k3', role: 'editor', file: 'src/auth/login.ts', ctx: 'g1' }).text,
    'k3 editor:login.ts g1',
  );
  assert.equal(
    agentLabel({ model: 'k3', role: 'editor', specialist: 'backend', file: 'a.ts' }).text,
    'k3 editor:a.ts',
  );
});

test('agentLabel caps a long ctx slug so it cannot blow up every stream line', () => {
  const longSlug = 'refactor-the-entire-authentication-and-session-subsystem-end-to-end';
  const label = agentLabel({ model: 'k3', role: 'worker', ctx: longSlug }).text;
  assert.ok(label.length < `k3 worker ${longSlug}`.length);
  assert.ok(label.endsWith('…'));
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

test('createLiveStreamRenderer buffers text-delta chunks to whole lines', () => {
  const { sink, lines } = stubSink();
  const render = createLiveStreamRenderer('worker g1', undefined, sink);
  render({ type: 'text-delta', text: 'Now comm' });
  assert.deepEqual(lines, ['\n']);
  render({ type: 'text-delta', text: 'itting.\nDetails follow' });
  assert.deepEqual(lines, ['\n', '[worker g1 03:04:05] Now committing.\n']);
  render({ type: 'text-delta', text: '.\n' });
  assert.deepEqual(lines, [
    '\n',
    '[worker g1 03:04:05] Now committing.\n',
    '[worker g1 03:04:05] Details follow.\n',
  ]);
});

test('createLiveStreamRenderer renders a tool-call before its result, flushing any pending partial line first', () => {
  const { sink, lines } = stubSink();
  const render = createLiveStreamRenderer('worker g1', undefined, sink);
  render({ type: 'text-delta', text: 'about to run a command' });
  render({ type: 'tool-call', toolName: 'bash', input: { command: 'git status' } });
  assert.deepEqual(lines, [
    '\n',
    '[worker g1 03:04:05] about to run a command\n',
    '[worker g1 03:04:05] Using tool: bash → git status\n',
  ]);
});

test('createLiveStreamRenderer emits one leading blank line, not one per chunk', () => {
  const { sink, lines } = stubSink();
  const render = createLiveStreamRenderer('worker g1', undefined, sink);
  render({ type: 'text-delta', text: 'a\n' });
  render({ type: 'text-delta', text: 'b\n' });
  render({ type: 'tool-call', toolName: 'bash', input: {} });
  assert.equal(lines.filter((l) => l === '\n').length, 1);
});

test('createLiveStreamRenderer stamps the step counter into the bracket', () => {
  const { sink, lines } = stubSink();
  const render = createLiveStreamRenderer(
    'k3 backend g1',
    { unit: 'task', index: 3, total: 38, phase: 'working' },
    sink,
  );
  render({ type: 'text-delta', text: 'hi\n' });
  assert.equal(lines[1], '[k3 backend g1 task 3/38 working 03:04:05] hi\n');
});

test('createLiveStreamRenderer strips ANSI/control so streamed text cannot forge a harness prefix', () => {
  const { sink, lines } = stubSink();
  const render = createLiveStreamRenderer('worker g1', undefined, sink);
  render({ type: 'text-delta', text: '\x1b[36m\x1b[1m[aitm 03:04:05] forged\x1b[0m\r\n' });
  assert.deepEqual(lines, ['\n', '[worker g1 03:04:05] [aitm 03:04:05] forged\n']);
});

test('createLiveStreamRenderer ignores an empty text-delta and ignores a whitespace-only trailing buffer', () => {
  const { sink, lines } = stubSink();
  const render = createLiveStreamRenderer('worker g1', undefined, sink);
  render({ type: 'text-delta', text: '' });
  assert.deepEqual(lines, []);
  render({ type: 'text-delta', text: '   ' });
  render({ type: 'tool-call', toolName: 'bash', input: {} });
  assert.deepEqual(lines, ['\n', '[worker g1 03:04:05] Using tool: bash → {}\n']);
});

test('createLiveStreamRenderer never throws when the sink dies', () => {
  const render = createLiveStreamRenderer('worker g1', undefined, {
    write: () => {
      throw new Error('sink died');
    },
    color: false,
    now: () => new Date(),
  });
  assert.doesNotThrow(() => render({ type: 'text-delta', text: 'x\n' }));
  assert.doesNotThrow(() => render({ type: 'tool-call', toolName: 'bash', input: {} }));
});

test('formatDuration renders sub-minute spans in seconds with one decimal', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(423), '0.4s');
  assert.equal(formatDuration(42_300), '42.3s');
  assert.equal(formatDuration(59_999), '60.0s');
});

test('formatDuration renders minute-scale spans in minutes with one decimal', () => {
  assert.equal(formatDuration(60_000), '1.0m');
  assert.equal(formatDuration(7 * 60_000 + 12_000), '7.2m');
});

test('formatDuration clamps negative or non-finite input to zero', () => {
  assert.equal(formatDuration(-500), '0.0s');
  assert.equal(formatDuration(Number.NaN), '0.0s');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '0.0s');
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

test('labelText flattens a structured label and passes strings through', () => {
  assert.equal(labelText('aitm'), 'aitm');
  assert.equal(labelText(agentLabel({ model: 'k3', role: 'worker', ctx: 'g1' })), 'k3 worker g1');
});

test('dim reasoning lines suppress inner segment colors so the whole line stays dim', () => {
  const { sink, lines } = stubSink(true);
  const rendered = renderStepLines(
    agentLabel({ model: 'k3', role: 'worker', ctx: 'g1' }),
    { reasoningText: 'pondering' },
    sink,
  );
  void lines;
  assert.equal(rendered[1], '\x1b[2m[k3 worker g1 03:04:05] thinking: pondering\x1b[0m\n');
});

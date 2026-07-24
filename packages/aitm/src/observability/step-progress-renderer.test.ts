import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveStreamRenderer } from './step-progress-renderer.ts';
import type { ProgressSink } from './step-progress-sink.ts';

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

test('createLiveStreamRenderer redacts credentials in streamed text and tool calls', () => {
  const { sink, lines } = stubSink();
  const render = createLiveStreamRenderer('worker g1', undefined, sink);
  render({ type: 'text-delta', text: 'using sk-abcdef1234567890 now\n' });
  render({ type: 'tool-call', toolName: 'bash', input: { command: 'gh auth login --with-token' } });
  assert.equal(lines[1], '[worker g1 03:04:05] using sk-[REDACTED] now\n');
  assert.ok(!lines.join('').includes('abcdef1234567890'));
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

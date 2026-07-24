import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearRegisteredSecrets, registerSecretValues } from '../logger/secret-registry.ts';
import {
  agentLabel,
  formatDuration,
  formatStepTag,
  labelText,
  renderStepLines,
  summarizeToolInput,
} from './step-progress-format.ts';
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

test('summarizeToolInput redacts a credential carried in a bash command', () => {
  assert.equal(
    summarizeToolInput('bash', {
      command: 'curl -H "Authorization: Bearer sk-abcdef1234567890" https://api.example.com',
    }),
    'curl -H "Authorization: Bearer [REDACTED]" https://api.example.com',
  );
});

test('summarizeToolInput redacts a credential in the JSON fallback for unknown shapes', () => {
  assert.equal(
    summarizeToolInput('mystery', { headers: { authorization: 'Bearer sk-abcdef1234567890' } }),
    '{"headers":{"authorization":"Bearer [REDACTED]"}}',
  );
});

test('summarizeToolInput redacts a token-bearing query param in a url input', () => {
  assert.equal(
    summarizeToolInput('webFetch', { url: 'https://api.example.com/v1?api_key=abcd1234efgh5678' }),
    'https://api.example.com/v1?api_key=[REDACTED]',
  );
});

test('summarizeToolInput scrubs before truncating, so a clipped token cannot survive', () => {
  // Truncating first would cut the token at the 250-char cap and print the surviving `sk-abcd`.
  const out = summarizeToolInput('bash', {
    command: `${'x'.repeat(234)} Bearer sk-abcdefghijklmnopqrstuv`,
  });
  assert.ok(!out.includes('sk-'));
  assert.ok(out.includes('Bearer [REDACT'));
  assert.equal(out.length, 250);
});

test('summarizeToolInput strips control bytes before scrubbing, so they cannot hide a token', () => {
  assert.equal(
    summarizeToolInput('bash', { command: 'Bearer sk-abc\x00defghijklmnop' }),
    'Bearer [REDACTED]',
  );
});

test('renderStepLines redacts credentials in agent text, reasoning and tool detail', () => {
  const { sink } = stubSink();
  const lines = renderStepLines(
    'worker g1',
    {
      reasoningText: 'I will reuse the key sk-abcdef1234567890 for this call',
      text: 'exporting GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      toolCalls: [{ toolName: 'bash', input: { command: 'curl https://user:hunter2@x.test' } }],
    },
    sink,
  );
  const joined = lines.join('');
  assert.ok(!joined.includes('abcdef1234567890'));
  assert.ok(!joined.includes('ghp_1234567890'));
  assert.ok(!joined.includes('hunter2'));
  assert.equal(joined.match(/\[REDACTED\]/g)?.length, 3);
});

test('renderStepLines redacts a registered literal key no pattern would match', () => {
  // The key of a custom OpenAI-compatible endpoint: registered at startup from config/env, and the
  // only reason the progress stream can recognise it at all.
  const key = 'd93b7a10f4c62e58b0a4';
  const { sink } = stubSink();
  let joined: string;
  try {
    registerSecretValues([key]);
    joined = renderStepLines(
      'worker g1',
      {
        text: `exporting LLM_API_KEY=${key}`,
        toolCalls: [
          { toolName: 'bash', input: { command: `curl -H "X-Api: ${key}" llm.internal` } },
        ],
      },
      sink,
    ).join('');
  } finally {
    clearRegisteredSecrets();
  }
  assert.ok(!joined.includes(key), 'the literal key never reaches the terminal');
  assert.equal(joined.match(/\[REDACTED\]/g)?.length, 2);
});

test('renderStepLines sanitizes the tool name so it cannot forge a harness prefix', () => {
  const { sink } = stubSink();
  const lines = renderStepLines(
    'worker g1',
    { toolCalls: [{ toolName: 'ba\rsh', input: '' }] },
    sink,
  );
  assert.deepEqual(lines, ['\n', '[worker g1 03:04:05] Using tool: bash\n']);
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

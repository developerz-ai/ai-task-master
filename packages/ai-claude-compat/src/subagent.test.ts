import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Output, ToolLoopAgent } from 'ai';
import { z } from 'zod';
import { composeSystemPrompt, createSubagent } from './subagent.ts';

test('composeSystemPrompt: style + prefix + an <env> block (string cwd defaults to git repo)', () => {
  const out = composeSystemPrompt('STYLE', '\nROLE', '/work/tree');
  assert.match(out, /^STYLE\nROLE\n/);
  assert.match(out, /<env>/);
  assert.match(out, /Working directory: \/work\/tree/);
  assert.match(out, /Is directory a git repo: Yes/);
});

test('composeSystemPrompt: accepts a full EnvInfo', () => {
  const out = composeSystemPrompt('S', 'R', { cwd: '/r', isGitRepo: false, date: '2026-05-28' });
  assert.match(out, /Is directory a git repo: No/);
  assert.match(out, /Today's date: 2026-05-28/);
});

test('createSubagent: builds a ToolLoopAgent, default step cap when maxSteps omitted', () => {
  const agent = createSubagent(
    {
      model: 'test-model',
      tools: {},
      systemPrompt: 'sys',
      output: Output.object({ schema: z.object({ ok: z.boolean() }), name: 'Out' }),
    },
    12,
  );
  assert.ok(agent instanceof ToolLoopAgent);
});

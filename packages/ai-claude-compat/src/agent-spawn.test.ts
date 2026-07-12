import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ToolSet, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import {
  AGENT_TOOL_ERROR_PREFIX,
  AGENT_TOOL_NO_CONCLUSION,
  AGENT_TOOL_TRUNCATION_MARKER,
  AgentToolConstructionError,
  type AgentToolSpec,
  DEFAULT_AGENT_TOOL_MAX_OUTPUT_CHARS,
  makeAgentTool,
} from './agent-spawn.ts';

const SPEC: AgentToolSpec = {
  name: 'explore',
  description: 'Delegate a read-only survey.',
  systemPrompt: 'You survey the repo and return a self-contained answer.',
};

function emptyUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
    totalTokens: 2,
  };
}

// A model that answers with fixed text in one step. Records the prompt it received so a test can
// assert the child saw only its own self-contained input — no parent conversation.
function textModel(text: string): { model: MockLanguageModelV3; lastPrompt: () => unknown } {
  let seen: unknown;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      seen = opts.prompt;
      return {
        content: text === '' ? [] : [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  return { model, lastPrompt: () => seen };
}

function throwingModel(message: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error(message);
    },
  });
}

const readTools: ToolSet = {
  readFile: tool({
    description: 'read',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => 'x',
  }),
  grep: tool({
    description: 'grep',
    inputSchema: z.object({ q: z.string() }),
    execute: async () => 'y',
  }),
};

async function run(
  t: { execute?: unknown },
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('tool has no execute');
  return (await (exec as (i: { prompt: string }, o: unknown) => Promise<string>)(
    { prompt },
    { toolCallId: 'test', messages: [], ...(abortSignal ? { abortSignal } : {}) },
  )) as string;
}

test('makeAgentTool: a call runs in a fresh context (only its own prompt) and returns the child final text', async () => {
  const { model, lastPrompt } = textModel('src/user.ts defines the User model at line 12.');
  const t = makeAgentTool(SPEC, { model, tools: readTools, allowedTools: ['readFile', 'grep'] });

  const out = await run(t, 'Where is the User model?');
  assert.equal(out, 'src/user.ts defines the User model at line 12.');

  // The child's request carries exactly one user turn — its self-contained prompt, no parent history.
  const messages = lastPrompt() as Array<{ role: string; content: unknown }>;
  const userTurns = messages.filter((m) => m.role === 'user');
  assert.equal(userTurns.length, 1, 'exactly one user turn');
  assert.equal(JSON.stringify(userTurns[0]?.content).includes('Where is the User model?'), true);
  assert.equal(
    messages.some((m) => m.role === 'assistant'),
    false,
    'no parent assistant history bled in',
  );
});

test('makeAgentTool: output beyond maxOutputChars is truncated to WITHIN the cap, marker included', async () => {
  const cap = 50;
  const long = 'a'.repeat(100);
  const { model } = textModel(long);
  const t = makeAgentTool(SPEC, {
    model,
    tools: readTools,
    allowedTools: ['readFile', 'grep'],
    maxOutputChars: cap,
  });

  const out = await run(t, 'q');
  // The marker's space is reserved inside the cap — the whole string never exceeds maxOutputChars.
  assert.ok(out.length <= cap, `stays within the advertised cap (got ${out.length})`);
  assert.ok(out.endsWith(AGENT_TOOL_TRUNCATION_MARKER), 'marker present');
  assert.equal(
    out,
    `${'a'.repeat(cap - AGENT_TOOL_TRUNCATION_MARKER.length)}${AGENT_TOOL_TRUNCATION_MARKER}`,
  );
});

test('makeAgentTool: a non-finite maxOutputChars falls back to the default cap (bound cannot be disabled)', async () => {
  const long = 'a'.repeat(DEFAULT_AGENT_TOOL_MAX_OUTPUT_CHARS + 100);
  const { model } = textModel(long);
  const t = makeAgentTool(SPEC, {
    model,
    tools: readTools,
    allowedTools: ['readFile', 'grep'],
    maxOutputChars: Number.POSITIVE_INFINITY,
  });

  const out = await run(t, 'q');
  assert.ok(
    out.length <= DEFAULT_AGENT_TOOL_MAX_OUTPUT_CHARS,
    'an invalid cap falls back to the default bound instead of disabling truncation',
  );
  assert.ok(out.endsWith(AGENT_TOOL_TRUNCATION_MARKER), 'truncation still applied');
});

test('makeAgentTool: a child that produces no final text returns the no-conclusion line (never empty)', async () => {
  const { model } = textModel('');
  const t = makeAgentTool(SPEC, { model, tools: readTools, allowedTools: ['readFile', 'grep'] });
  assert.equal(await run(t, 'q'), AGENT_TOOL_NO_CONCLUSION);
});

test('makeAgentTool: a child provider error is caught and returned as an error line, not thrown', async () => {
  const t = makeAgentTool(SPEC, {
    model: throwingModel('upstream 500'),
    tools: readTools,
    allowedTools: ['readFile', 'grep'],
  });
  const out = await run(t, 'q');
  assert.ok(out.startsWith(AGENT_TOOL_ERROR_PREFIX), 'error line prefix');
  assert.ok(out.includes('upstream 500'), 'carries the provider message');
});

test('makeAgentTool: a toolset key outside allowedTools fails construction with a typed error', () => {
  const withWriter: ToolSet = {
    ...readTools,
    writeFile: tool({
      description: 'w',
      inputSchema: z.object({ p: z.string() }),
      execute: async () => 'ok',
    }),
  };
  assert.throws(
    () =>
      makeAgentTool(SPEC, {
        model: textModel('x').model,
        tools: withWriter,
        allowedTools: ['readFile', 'grep'],
      }),
    (err: unknown) =>
      err instanceof AgentToolConstructionError && /writeFile/.test((err as Error).message),
  );
});

test('makeAgentTool: a toolset containing the tool own name fails construction (no recursion)', () => {
  const recursive: ToolSet = {
    ...readTools,
    explore: tool({
      description: 'self',
      inputSchema: z.object({ prompt: z.string() }),
      execute: async () => 'ok',
    }),
  };
  assert.throws(
    () =>
      makeAgentTool(SPEC, {
        model: textModel('x').model,
        tools: recursive,
        allowedTools: ['readFile', 'grep', 'explore'],
      }),
    (err: unknown) =>
      err instanceof AgentToolConstructionError && /recursion/.test((err as Error).message),
  );
});

test('makeAgentTool: two parallel execute calls return independent, uncorrupted results', async () => {
  // Each tool gets its own model returning a distinct answer; running both via Promise.all must not
  // cross-contaminate (execute closes over no mutable state).
  const a = makeAgentTool(SPEC, {
    model: textModel('answer-A').model,
    tools: readTools,
    allowedTools: ['readFile', 'grep'],
  });
  const b = makeAgentTool(SPEC, {
    model: textModel('answer-B').model,
    tools: readTools,
    allowedTools: ['readFile', 'grep'],
  });
  const [ra, rb] = await Promise.all([run(a, 'qa'), run(b, 'qb')]);
  assert.equal(ra, 'answer-A');
  assert.equal(rb, 'answer-B');
});

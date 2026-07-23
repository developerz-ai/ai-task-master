import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ToolSet, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import {
  AGENT_TOOL_DEPTH_EXCEEDED_PREFIX,
  AGENT_TOOL_ERROR_PREFIX,
  AGENT_TOOL_NO_CONCLUSION,
  AGENT_TOOL_TRUNCATION_MARKER,
  AgentToolConstructionError,
  type AgentToolSpec,
  DEFAULT_AGENT_TOOL_MAX_DEPTH,
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

// ---- transitive subagent depth guard (issue #270) ----
// Depth is threaded through experimental_context under a private key, so these tests exercise it the
// only faithful way: build a real chain (an agent tool whose child invokes a nested agent tool) and
// observe behavior — the nested delegate spawns or is refused depending on the cap.

const INNER_SPEC: AgentToolSpec = {
  name: 'inner',
  description: 'A nested delegate mounted inside another agent tool to exercise transitive depth.',
  systemPrompt: 'You are a nested survey.',
};

// A model that calls `toolName` with `input` on its first step. On a later step it concludes: with
// `finalText` when given, otherwise by echoing the running prompt (which by then carries the nested
// tool result) so a test can inspect what that nested call returned.
function callToolThenConclude(
  toolName: string,
  input: string,
  finalText?: string,
): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      if (i++ === 0) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-0', toolName, input }],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: finalText ?? JSON.stringify(opts.prompt) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
}

// Run an agent tool with a caller-supplied experimental_context (the parent's own context object).
async function runWithContext(
  t: { execute?: unknown },
  prompt: string,
  experimentalContext: unknown,
): Promise<string> {
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('tool has no execute');
  return (await (exec as (i: { prompt: string }, o: unknown) => Promise<string>)(
    { prompt },
    { toolCallId: 'test', messages: [], experimental_context: experimentalContext },
  )) as string;
}

test('makeAgentTool: the default depth cap is a single level of delegation', () => {
  assert.equal(DEFAULT_AGENT_TOOL_MAX_DEPTH, 1);
});

test('makeAgentTool: at the default cap a nested delegate one level down is refused before it spawns', async () => {
  const inner = textModel('INNER RAN');
  const innerTool = makeAgentTool(INNER_SPEC, {
    model: inner.model,
    tools: readTools,
    allowedTools: ['readFile', 'grep'],
  });
  const outer = makeAgentTool(SPEC, {
    model: callToolThenConclude('inner', '{"prompt":"go deeper"}'),
    tools: { ...readTools, inner: innerTool },
    allowedTools: ['readFile', 'grep', 'inner'],
  });

  // The outer child runs at depth 1; its attempt to delegate to `inner` would be depth 2, past the
  // cap of 1. The call is refused before spawning: inner's model never runs, and the refusal wording
  // is delivered back into the child as an ordinary tool result (returned, not thrown).
  const out = await run(outer, 'top-level task');
  assert.equal(inner.lastPrompt(), undefined, 'nested delegate never spawned');
  assert.equal(
    out.includes(AGENT_TOOL_DEPTH_EXCEEDED_PREFIX),
    true,
    'refusal delivered to the child',
  );
});

test('makeAgentTool: raising maxDepth lets the nested delegate one level down actually run', async () => {
  const inner = textModel('INNER RAN');
  const innerTool = makeAgentTool(INNER_SPEC, {
    model: inner.model,
    tools: readTools,
    allowedTools: ['readFile', 'grep'],
    maxDepth: 2,
  });
  const outer = makeAgentTool(SPEC, {
    model: callToolThenConclude('inner', '{"prompt":"go deeper"}'),
    tools: { ...readTools, inner: innerTool },
    allowedTools: ['readFile', 'grep', 'inner'],
  });

  // inner's own cap is 2, so at depth 1 (1 < 2) it spawns for real and its answer flows back.
  const out = await run(outer, 'top-level task');
  assert.notEqual(inner.lastPrompt(), undefined, 'nested delegate spawned under the raised cap');
  assert.equal(out.includes('INNER RAN'), true, 'nested answer reached the child');
});

test('makeAgentTool: a non-positive or non-finite maxDepth falls back to the default (guard cannot be disabled)', async () => {
  // A literal 0 or negative cap would refuse even a top-level (depth 0) call — disabling the tool. The
  // fallback to the default cap of 1 keeps it alive, so a top-level call must still run.
  for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const inner = textModel('INNER RAN');
    const t = makeAgentTool(INNER_SPEC, {
      model: inner.model,
      tools: readTools,
      allowedTools: ['readFile', 'grep'],
      maxDepth: bad,
    });
    const out = await run(t, 'top-level');
    assert.equal(out, 'INNER RAN', `maxDepth=${String(bad)} must fall back, not disable the tool`);
  }
});

test('makeAgentTool: a spawned child preserves the caller context, riding depth alongside it', async () => {
  let seen: unknown;
  const spy = tool({
    description: 'records the context it is invoked with',
    inputSchema: z.object({ q: z.string() }),
    execute: async (_input, options) => {
      seen = options.experimental_context;
      return 'ok';
    },
  });
  const outer = makeAgentTool(SPEC, {
    model: callToolThenConclude('spy', '{"q":"1"}', 'DONE'),
    tools: { ...readTools, spy },
    allowedTools: ['readFile', 'grep', 'spy'],
  });

  const out = await runWithContext(outer, 'top', { marker: 'PARENT' });
  assert.equal(out, 'DONE');
  // The child's tools still see the caller's own context field — depth was merged in, not swapped out.
  assert.equal(
    typeof seen === 'object' && seen !== null ? (seen as { marker?: unknown }).marker : undefined,
    'PARENT',
  );
});

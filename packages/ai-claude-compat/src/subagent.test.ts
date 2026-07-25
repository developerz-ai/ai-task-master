import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { simulateReadableStream, ToolLoopAgent, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { envBlock } from './env-block.ts';
import { communicationContractBlock, identityBlock } from './prompt-blocks.ts';
import {
  callWithRetry,
  callWithStepTimeout,
  composeSystemPrompt,
  consumeStreamWithWatchdog,
  continueSubagent,
  createSubagent,
  DEFAULT_LLM_MAX_RETRIES,
  defaultRetryDelayMs,
  formatSubmitIssues,
  isRetryableProviderError,
  MAX_STREAM_STALL_RETRIES,
  parseRetryAfterMs,
  type RetryInfo,
  runSubagent,
  runWithSchemaRetry,
  StepTimeoutError,
  StreamStallError,
  type StreamTimerFactory,
  SUBMIT_TOOL_NAME,
  type SubagentStreamEvent,
  submittedOutput,
  withTimeout,
} from './subagent.ts';

const OutSchema = z.object({ n: z.number() });
// A payload whose text field can carry braces and quotes — the shape that proves the balanced-object
// scan is string-aware rather than counting braces blindly.
const LooseSchema = z.object({ n: z.number(), note: z.string() });

function emptyUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
    totalTokens: 2,
  };
}

// A submit tool built with a concrete schema — the createSubagent contract.
function submitTool(schema: z.ZodType) {
  return tool({ description: 'submit the result', inputSchema: schema, execute: async (x) => x });
}

// Mock model that emits a `submit` tool-call carrying a raw input string, chosen per call index by
// `inputForCall`. A JSON string that fails the schema drives the `invalid` path; `noSubmit` drives
// `no-submission`. Records each call's prompt for corrective-message assertions.
function scriptedModel(inputForCall: (idx: number) => { submit: string } | { noSubmit: true }): {
  model: MockLanguageModelV3;
  calls: () => number;
  promptAt: (i: number) => string;
} {
  let i = 0;
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const idx = i++;
      prompts[idx] = JSON.stringify(opts.prompt);
      const spec = inputForCall(idx);
      if ('noSubmit' in spec) {
        return {
          content: [{ type: 'text', text: 'thinking, no submit yet' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${idx}`,
            toolName: 'submit',
            input: spec.submit,
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  return { model, calls: () => i, promptAt: (n) => prompts[n] ?? '' };
}

function agentFor(model: MockLanguageModelV3): ToolLoopAgent<never, Record<string, never>> {
  return createSubagent(
    { model, tools: {}, systemPrompt: 'sys', submit: submitTool(OutSchema) },
    12,
  );
}

// A model that STREAMS a submit: emits `deltas` as assistant text, then a `submit` tool-call carrying
// the stringified `input`, then a tool-calls finish. The streaming analogue of scriptedModel, driving
// the funnel through streamText end-to-end (fullStream → parity result). doStreamCalls tracks calls.
function streamingSubmitModel(deltas: readonly string[], input: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end', id: 't1' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'submit', input },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: emptyUsage(),
          },
        ],
      }),
    }),
  });
}

// --- composeSystemPrompt ---

test('composeSystemPrompt: style + prefix + an <env> block; the string cwd detects the git flag (issue #116)', async () => {
  // Hermetic: own temp dir with a real .git so the assertion doesn't depend on ambient checkout state.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-git-'));
  try {
    await mkdir(join(dir, '.git'));
    const out = composeSystemPrompt('STYLE', '\nROLE', dir);
    assert.match(out, /^STYLE\nROLE\n/);
    assert.match(out, /<env>/);
    assert.ok(out.includes(`Working directory: ${dir}`));
    assert.match(out, /Is directory a git repo: Yes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('composeSystemPrompt: a non-git cwd renders "No" — the string shorthand no longer hardcodes Yes (issue #116)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-nogit-'));
  try {
    assert.match(composeSystemPrompt('S', 'R', dir), /Is directory a git repo: No/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('composeSystemPrompt: accepts a full EnvInfo', () => {
  const out = composeSystemPrompt('S', 'R', { cwd: '/r', isGitRepo: false, date: '2026-05-28' });
  assert.match(out, /Is directory a git repo: No/);
  assert.match(out, /Today's date: 2026-05-28/);
});

test('composeSystemPrompt: the 3-arg overload stays byte-identical to style+prefix+\\n+envBlock (issue #105)', () => {
  const env = { cwd: '/r', isGitRepo: false, date: '2026-05-28' };
  assert.equal(composeSystemPrompt('STYLE', '\nROLE', env), `STYLE\nROLE\n${envBlock(env)}`);
});

test('composeSystemPrompt: the block-pipeline overload renders blocks in canonical order (issue #105)', () => {
  // Shuffled input; the pipeline sorts identity before communicationContract regardless.
  const out = composeSystemPrompt([communicationContractBlock(), identityBlock('You are X.')]);
  assert.ok(out.indexOf('You are X.') < out.indexOf('Communication contract'), 'identity first');
});

// --- createSubagent (submit-contract shape) ---

test('createSubagent: forwards onStepFinish to the agent, fired per step with response messages + usage (issue #108)', async () => {
  const { model } = scriptedModel(() => ({ submit: '{"n":1}' }));
  const steps: Array<{ messagesIsArray: boolean; hasUsage: boolean }> = [];
  const agent = createSubagent(
    {
      model,
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStepFinish: (event) => {
        steps.push({
          messagesIsArray: Array.isArray(event.response.messages),
          hasUsage: event.usage !== undefined,
        });
      },
    },
    12,
  );
  await runSubagent(agent, 'go');
  assert.ok(steps.length >= 1, 'onStepFinish fired at least once');
  assert.deepEqual(steps[0], { messagesIsArray: true, hasUsage: true });
});

test('createSubagent: builds a ToolLoopAgent registering the submit tool alongside caller tools', () => {
  const readFile = tool({
    description: 'read',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => ({ content: '' }),
  });
  const agent = createSubagent(
    {
      model: new MockLanguageModelV3(),
      tools: { readFile },
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
    },
    12,
  );
  assert.ok(agent instanceof ToolLoopAgent);
  assert.deepEqual(Object.keys(agent.tools).sort(), [SUBMIT_TOOL_NAME, 'readFile'].sort());
});

test('createSubagent: providerOptions reaches the model on generate (issue #112)', async () => {
  let seen: unknown;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      seen = opts.providerOptions;
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 's',
            toolName: 'submit',
            input: JSON.stringify({ n: 1 }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const providerOptions = {
    openrouter: { tools: [{ type: 'openrouter:web_search', parameters: {} }] },
  };
  const agent = createSubagent(
    { model, tools: {}, systemPrompt: 'sys', submit: submitTool(OutSchema), providerOptions },
    12,
  );
  await agent.generate({ messages: [{ role: 'user', content: 'go' }] });
  // The comment-correction's regression: the providerOptions key must actually reach the wire.
  assert.deepEqual(seen, providerOptions);
});

test('createSubagent: forwards an optional prepareStep into the agent loop (issue #102)', async () => {
  let prepareCalls = 0;
  const s = scriptedModel(() => ({ submit: JSON.stringify({ n: 1 }) }));
  const agent = createSubagent(
    {
      model: s.model,
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      prepareStep: async () => {
        prepareCalls++;
        return undefined;
      },
    },
    12,
  );
  await agent.generate({ prompt: 'go' });
  assert.ok(prepareCalls >= 1, 'the SDK invoked the passed-through prepareStep');
});

// --- per-step timeout arming (issue #129) ---

// A model whose doGenerate never settles on its own — it resolves only by rejecting when the merged
// abortSignal fires. Proves the deadline is armed at *generate* time: a settings-only passthrough
// (dead in ai@6.0.182) would never abort this and the call would hang.
function stallingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () => {
          const reason = opts.abortSignal?.reason;
          reject(
            reason instanceof Error
              ? reason
              : new DOMException('This operation was aborted', 'AbortError'),
          );
        });
      }),
  });
}

test('withTimeout: returns the options unchanged when the timeout is undefined (issue #139)', () => {
  const options = { model: 'm', prompt: 'p' };
  const result = withTimeout(options, undefined);
  assert.equal(result, options);
  assert.deepEqual(result, { model: 'm', prompt: 'p' });
});

test('withTimeout: merges the timeout into a fresh object when one is configured (issue #139)', () => {
  const options = { model: 'm', prompt: 'p' };
  const result = withTimeout(options, { stepMs: 40 });
  assert.notEqual(result, options);
  assert.deepEqual(result, { model: 'm', prompt: 'p', timeout: { stepMs: 40 } });
  assert.deepEqual(options, { model: 'm', prompt: 'p' });
});

test('createSubagent: arms a per-step deadline at generate time — a stalled provider is aborted (issue #129)', async () => {
  const agent = createSubagent(
    {
      model: stallingModel(),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      timeout: { stepMs: 40 },
    },
    12,
  );
  await assert.rejects(agent.generate({ prompt: 'go' }), (err: unknown) => {
    assert.ok(err instanceof StepTimeoutError, 'surfaces a StepTimeoutError');
    assert.match((err as Error).message, /exceeded the configured deadline \(40 ms\)/);
    return true;
  });
});

test('createSubagent: a per-call timeout overrides the configured one (issue #129)', async () => {
  // Configured deadline is effectively infinite; the short per-call timeout is what must fire, so a
  // fast abort proves the per-call value won. The wrapper passes caller-supplied timeouts straight
  // through, so the SDK's raw abort surfaces (translation is the caller's concern here).
  const agent = createSubagent(
    {
      model: stallingModel(),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      timeout: { stepMs: 100_000 },
    },
    12,
  );
  await assert.rejects(
    agent.generate({ prompt: 'go', timeout: { stepMs: 40 } }),
    (err: unknown) => err instanceof Error && !(err instanceof StepTimeoutError),
  );
});

test('createSubagent: with timeout omitted no deadline is armed — a stalled step stays pending (issue #129)', async () => {
  const ac = new AbortController();
  const agent = createSubagent(
    { model: stallingModel(), tools: {}, systemPrompt: 'sys', submit: submitTool(OutSchema) },
    12,
  );
  const gen = agent.generate({ prompt: 'go', abortSignal: ac.signal }).then(
    () => 'settled',
    () => 'settled',
  );
  const pending = await Promise.race([gen, new Promise((r) => setTimeout(() => r('pending'), 80))]);
  assert.equal(pending, 'pending', 'no deadline fired at 80ms — the call is still in flight');
  ac.abort(); // clean up the in-flight generate
  await gen;
});

// A model whose first doGenerate call throws a transient (retryable) provider error, then submits
// on the next call — drives the onRetry-wiring tests below through a real generate() round trip.
function retryOnceThenSubmitModel(): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
      return {
        content: [
          { type: 'tool-call', toolCallId: 'submit-1', toolName: 'submit', input: '{"n":1}' },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
}

test('createSubagent: forwards onRetry to the retry kernel alongside a configured timeout (issue #01b)', async () => {
  const infos: RetryInfo[] = [];
  const agent = createSubagent(
    {
      model: retryOnceThenSubmitModel(),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      timeout: { stepMs: 5_000 },
      onRetry: (info) => void infos.push(info),
    },
    12,
  );
  const result = await agent.generate({ prompt: 'go' });
  assert.equal(result.finishReason, 'tool-calls');
  assert.equal(infos.length, 1, 'the transient 429 was retried once, reported via onRetry');
  assert.equal(infos[0]?.reason, 'HTTP 429');
});

test('createSubagent: onRetry fires even with no configured timeout — retry visibility does not require a deadline (issue #01b)', async () => {
  const infos: RetryInfo[] = [];
  const agent = createSubagent(
    {
      model: retryOnceThenSubmitModel(),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onRetry: (info) => void infos.push(info),
    },
    12,
  );
  const result = await agent.generate({ prompt: 'go' });
  assert.equal(result.finishReason, 'tool-calls');
  assert.equal(infos.length, 1, 'onRetry armed generate() even though no timeout was configured');
});

// --- run cancellation (signal) ---

// Abort on the next macrotask, so the generate is genuinely in flight when the signal fires.
function abortSoon(controller: AbortController): void {
  setTimeout(() => controller.abort(), 5);
}

test('runSubagent: forwards the caller signal — aborting mid-generate rejects the run', async () => {
  const ac = new AbortController();
  const agent = createSubagent(
    { model: stallingModel(), tools: {}, systemPrompt: 'sys', submit: submitTool(OutSchema) },
    12,
  );
  abortSoon(ac);
  await assert.rejects(runSubagent(agent, 'go', { signal: ac.signal }), (err: unknown) => {
    assert.ok(err instanceof Error && err.name === 'AbortError', 'surfaces the SDK abort');
    return true;
  });
});

test('runSubagent: a caller signal does NOT disarm the configured per-step deadline', async () => {
  // The signal never fires; the 40ms deadline must still abort the stalled provider. Guards the
  // regression where any caller abortSignal made the wrapper skip timeout arming entirely.
  const ac = new AbortController();
  const agent = createSubagent(
    {
      model: stallingModel(),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      timeout: { stepMs: 40 },
    },
    12,
  );
  await assert.rejects(runSubagent(agent, 'go', { signal: ac.signal }), (err: unknown) => {
    assert.ok(err instanceof StepTimeoutError, 'the deadline still fires with a signal present');
    assert.match((err as Error).message, /exceeded the configured deadline \(40 ms\)/);
    return true;
  });
});

test('runSubagent: a caller abort is not relabelled as a deadline breach', async () => {
  // Deadline effectively infinite, so the only abort is the caller's — it must surface as a plain
  // abort, never a StepTimeoutError, or a Ctrl-C would be reported as a stalled provider.
  const ac = new AbortController();
  const agent = createSubagent(
    {
      model: stallingModel(),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      timeout: { stepMs: 100_000 },
    },
    12,
  );
  abortSoon(ac);
  await assert.rejects(runSubagent(agent, 'go', { signal: ac.signal }), (err: unknown) => {
    assert.ok(!(err instanceof StepTimeoutError), 'the caller cancel is not a deadline breach');
    assert.ok(err instanceof Error && err.name === 'AbortError');
    return true;
  });
});

test('runSubagent: with no signal the generate is untouched — an unaborted run still submits', async () => {
  const { model } = scriptedModel(() => ({ submit: JSON.stringify({ n: 3 }) }));
  const { result } = await runSubagent(agentFor(model), 'go');
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 3 } });
});

test('continueSubagent: forwards the caller signal — aborting mid-continuation rejects', async () => {
  let stall = false;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      if (stall) {
        return new Promise((_resolve, reject) => {
          opts.abortSignal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError')),
          );
        });
      }
      return {
        content: [
          { type: 'tool-call', toolCallId: 'submit-1', toolName: 'submit', input: '{"n":1}' },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { handle } = await runSubagent(agentFor(model), 'go');
  stall = true;
  const ac = new AbortController();
  abortSoon(ac);
  await assert.rejects(
    continueSubagent(handle, 'more', { signal: ac.signal }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
});

// --- agent-scoped run cancellation (SubagentConfig.signal) ---

function stallingAgent(config: { signal?: AbortSignal; timeout?: { stepMs: number } } = {}) {
  return createSubagent(
    {
      model: stallingModel(),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      ...(config.signal ? { signal: config.signal } : {}),
      ...(config.timeout ? { timeout: config.timeout } : {}),
    },
    12,
  );
}

test('createSubagent: the run signal cancels a generation the caller does not drive (schema retry)', async () => {
  // runWithSchemaRetry owns its generations, so a per-call signal can never reach them — the agent's
  // own signal is the only way a Ctrl-C aborts a planner/reviewer/scout leg.
  const ac = new AbortController();
  const agent = stallingAgent({ signal: ac.signal });
  abortSoon(ac);
  await assert.rejects(
    runWithSchemaRetry(agent, OutSchema, 'go'),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
});

test('createSubagent: a run signal does NOT disarm the configured per-step deadline', async () => {
  // The signal never fires; the 40ms deadline must still abort the stalled provider.
  const ac = new AbortController();
  const agent = stallingAgent({ signal: ac.signal, timeout: { stepMs: 40 } });
  await assert.rejects(agent.generate({ prompt: 'go' }), (err: unknown) => {
    assert.ok(
      err instanceof StepTimeoutError,
      'the deadline still fires with a run signal present',
    );
    return true;
  });
});

test('createSubagent: a run-signal abort is not relabelled as a deadline breach', async () => {
  const ac = new AbortController();
  const agent = stallingAgent({ signal: ac.signal, timeout: { stepMs: 100_000 } });
  abortSoon(ac);
  await assert.rejects(agent.generate({ prompt: 'go' }), (err: unknown) => {
    assert.ok(!(err instanceof StepTimeoutError), 'the run cancel is not a deadline breach');
    assert.ok(err instanceof Error && err.name === 'AbortError');
    return true;
  });
});

test('createSubagent: the run signal composes with a per-call abortSignal — either one cancels', async () => {
  const run = new AbortController();
  const perCall = new AbortController();
  abortSoon(run);
  await assert.rejects(
    stallingAgent({ signal: run.signal }).generate({ prompt: 'go', abortSignal: perCall.signal }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
    'the run signal still reaches a call that brought its own signal',
  );

  const otherRun = new AbortController();
  const otherCall = new AbortController();
  abortSoon(otherCall);
  await assert.rejects(
    stallingAgent({ signal: otherRun.signal }).generate({
      prompt: 'go',
      abortSignal: otherCall.signal,
    }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
    'the per-call signal is not swallowed by the run signal',
  );
});

test('createSubagent: the composed-signal bridge is released once the generate settles (no leak)', async () => {
  // A run signal outlives many generations; one retained bridge listener per call leaks the finished
  // controller and trips the runtime max-listener warning on a long run.
  const run = new AbortController();
  const perCall = new AbortController();
  const agent = createSubagent(
    {
      model: scriptedModel(() => ({ submit: JSON.stringify({ n: 5 }) })).model,
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      signal: run.signal,
    },
    12,
  );
  const result = await agent.generate({ prompt: 'go', abortSignal: perCall.signal });
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 5 } });
  assert.equal(getEventListeners(run.signal, 'abort').length, 0, 'run signal listener removed');
  assert.equal(
    getEventListeners(perCall.signal, 'abort').length,
    0,
    'call signal listener removed',
  );
});

test('callWithRetry: an aborted signal ends the retry loop instead of sleeping out the backoff', async () => {
  const ac = new AbortController();
  let calls = 0;
  let slept = 0;
  await assert.rejects(
    callWithRetry(
      async () => {
        calls += 1;
        ac.abort();
        throw Object.assign(new Error('rate limited'), { statusCode: 429 });
      },
      {
        signal: ac.signal,
        sleep: async () => {
          slept += 1;
        },
      },
    ),
    (err: unknown) => err instanceof Error && err.message === 'rate limited',
  );
  assert.equal(calls, 1, 'a retryable failure is not re-attempted once the caller cancelled');
  assert.equal(slept, 0, 'no backoff window is waited out on a cancelled run');
});

test('callWithRetry: an unaborted signal leaves the retry loop untouched', async () => {
  const ac = new AbortController();
  let calls = 0;
  const value = await callWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
      return 'ok';
    },
    { signal: ac.signal, sleep: async () => {} },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 2, 'the transient failure was still retried');
});

test('streaming funnel: the caller signal is unhooked once the stream drains (no listener leak)', async () => {
  // A run-scoped signal outlives many generations; one retained bridge listener per stream leaks the
  // finished controller and trips the runtime max-listener warning on a long run.
  const ac = new AbortController();
  const agent = createSubagent(
    {
      model: streamingSubmitModel(['hi'], JSON.stringify({ n: 1 })),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStream: () => {},
    },
    12,
  );
  const { result } = await runSubagent(agent, 'go', { signal: ac.signal });
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 1 } });
  assert.equal(
    getEventListeners(ac.signal, 'abort').length,
    0,
    'the stream bridge removed its abort listener',
  );
});

// --- streaming funnel parity (slice 07) ---

test('streaming funnel: a streamed submit resolves to the same result shape as generateText (slice 07)', async () => {
  const agent = createSubagent(
    {
      model: streamingSubmitModel(['Hel', 'lo'], JSON.stringify({ n: 7 })),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStream: () => {},
    },
    12,
  );
  const { result } = await runSubagent(agent, 'go');
  // The terminal shape every downstream reader depends on is identical to the non-streaming funnel.
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 7 } });
  assert.equal(result.finishReason, 'tool-calls');
  assert.ok(
    Array.isArray(result.response.messages) && result.response.messages.length >= 1,
    'response.messages is populated for continuation',
  );
  assert.ok(result.totalUsage !== undefined, 'usage resolves for metering');
});

test('streaming funnel: forwards text-delta then tool-call events to onStream, in order (slice 07)', async () => {
  const events: SubagentStreamEvent[] = [];
  const agent = createSubagent(
    {
      model: streamingSubmitModel(['Hel', 'lo'], JSON.stringify({ n: 1 })),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStream: (event) => events.push(event),
    },
    12,
  );
  await runSubagent(agent, 'go');
  const streamedText = events
    .filter((event) => event.type === 'text-delta')
    .map((event) => event.text)
    .join('');
  assert.equal(
    streamedText,
    'Hello',
    'text deltas arrive in order and concatenate to the full text',
  );
  const toolCall = events.find((event) => event.type === 'tool-call');
  assert.ok(toolCall && toolCall.type === 'tool-call', 'a tool-call event was forwarded');
  assert.equal(toolCall.toolName, 'submit');
  assert.deepEqual(toolCall.input, { n: 1 }, 'the parsed submit input rides the event');
  assert.equal(
    events.findIndex((event) => event.type === 'tool-call'),
    events.length - 1,
    'the tool-call event follows every text delta',
  );
});

test('streaming funnel: onStream gates the path — off uses doGenerate, on uses doStream (slice 07)', async () => {
  // A model wired for BOTH paths; the funnel must pick exactly one per the onStream opt-in, so the
  // default (no onStream) stays byte-identical to the existing generateText path.
  const bothModel = () =>
    new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'g',
            toolName: 'submit',
            input: JSON.stringify({ n: 1 }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      }),
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 's',
              toolName: 'submit',
              input: JSON.stringify({ n: 2 }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: emptyUsage(),
            },
          ],
        }),
      }),
    });

  const offModel = bothModel();
  await runSubagent(
    createSubagent(
      { model: offModel, tools: {}, systemPrompt: 'sys', submit: submitTool(OutSchema) },
      12,
    ),
    'go',
  );
  assert.equal(offModel.doGenerateCalls.length, 1, 'no onStream → generateText');
  assert.equal(offModel.doStreamCalls.length, 0, 'no onStream → never streams');

  const onModel = bothModel();
  await runSubagent(
    createSubagent(
      {
        model: onModel,
        tools: {},
        systemPrompt: 'sys',
        submit: submitTool(OutSchema),
        onStream: () => {},
      },
      12,
    ),
    'go',
  );
  assert.equal(onModel.doStreamCalls.length, 1, 'onStream → streamText');
  assert.equal(onModel.doGenerateCalls.length, 0, 'onStream → never falls back to generate');
});

test('streaming funnel: the retry kernel still wraps the whole stream — a transient failure re-invokes it (slice 07)', async () => {
  // The first doStream throws a transient 429; the second streams a submit. Because the stream runs
  // INSIDE the retry/timeout kernel, the whole stream is retried and onRetry fires — wrappers unchanged.
  let calls = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'submit',
              input: JSON.stringify({ n: 9 }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: emptyUsage(),
            },
          ],
        }),
      };
    },
  });
  const infos: RetryInfo[] = [];
  const agent = createSubagent(
    {
      model,
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      timeout: { stepMs: 5_000 },
      onStream: () => {},
      onRetry: (info) => void infos.push(info),
    },
    12,
  );
  const { result } = await runSubagent(agent, 'go');
  assert.equal(calls, 2, 'the stream was re-invoked after the transient failure');
  assert.equal(infos.length, 1, 'the transient 429 was reported once via onRetry');
  assert.equal(infos[0]?.reason, 'HTTP 429');
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 9 } });
});

test('streaming funnel: a throwing onStream never breaks the generation (slice 07)', async () => {
  const agent = createSubagent(
    {
      model: streamingSubmitModel(['x'], JSON.stringify({ n: 3 })),
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStream: () => {
        throw new Error('sink boom');
      },
    },
    12,
  );
  const { result } = await runSubagent(agent, 'go');
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 3 } });
});

// --- streaming stall watchdog (slice 07) ---

// Feed consumeStreamWithWatchdog by hand: each part resolves on a microtask (which always beats the
// recordingTimer's setTimeout(0) macrotask, so a fed part never loses the race), then the tail either
// ends the stream or hangs forever — the two ways a real fullStream terminates.
function scriptedParts<PART>(parts: readonly PART[], tail: 'end' | 'hang'): AsyncIterable<PART> {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<PART>> {
          if (i < parts.length) {
            const value = parts[i];
            i += 1;
            if (value === undefined) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value });
          }
          if (tail === 'hang') return new Promise<IteratorResult<PART>>(() => {});
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

// A timer factory that records each armed window and fires on a macrotask, so the two-regime switch is
// asserted by the recorded windows rather than by racing real wall-clock.
function recordingTimer(): { factory: StreamTimerFactory; windows: readonly number[] } {
  const windows: number[] = [];
  const factory: StreamTimerFactory = (ms) => {
    windows.push(ms);
    let handle: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, 0);
    });
    return {
      expired,
      cancel: () => {
        if (handle !== undefined) clearTimeout(handle);
      },
    };
  };
  return { factory, windows };
}

const isFinishPart = (part: { type: string }) => part.type === 'finish';

test('watchdog: a clean stream drains, never aborts, and re-arms the inactivity window each read', async () => {
  const timer = recordingTimer();
  const seen: string[] = [];
  let aborts = 0;
  const outcome = await consumeStreamWithWatchdog(
    scriptedParts([{ type: 'text-delta' }, { type: 'tool-call' }], 'end'),
    { onPart: (part) => seen.push(part.type), isFinish: isFinishPart, abort: () => (aborts += 1) },
    { inactivityMs: 111, graceMs: 22, timer: timer.factory },
  );
  assert.equal(outcome, 'drained');
  assert.deepEqual(seen, ['text-delta', 'tool-call'], 'every part is forwarded in order');
  assert.equal(aborts, 0, 'a clean drain never aborts');
  assert.deepEqual(
    timer.windows,
    [111, 111, 111],
    'the inactivity window is re-armed for each read incl. the closing one — no finish, so never grace',
  );
});

test('watchdog: a stall before finish aborts and reports stalled-active (→ caller retries)', async () => {
  const timer = recordingTimer();
  let aborts = 0;
  const outcome = await consumeStreamWithWatchdog(
    scriptedParts([{ type: 'text-delta' }], 'hang'),
    { onPart: () => {}, isFinish: isFinishPart, abort: () => (aborts += 1) },
    { inactivityMs: 50, graceMs: 10, timer: timer.factory },
  );
  assert.equal(outcome, 'stalled-active', 'a mid-stream stall signals a retry');
  assert.equal(aborts, 1, 'the stalled stream was aborted exactly once');
  assert.deepEqual(
    timer.windows,
    [50, 50],
    'both reads used the inactivity window (no finish yet)',
  );
});

test('watchdog: a stall after finish reports stalled-grace (→ caller settles, never retries)', async () => {
  const timer = recordingTimer();
  let aborts = 0;
  const outcome = await consumeStreamWithWatchdog(
    scriptedParts([{ type: 'finish' }], 'hang'),
    { onPart: () => {}, isFinish: isFinishPart, abort: () => (aborts += 1) },
    { inactivityMs: 999, graceMs: 30, timer: timer.factory },
  );
  assert.equal(outcome, 'stalled-grace', 'a post-finish stall settles — it never signals a retry');
  assert.equal(
    aborts,
    1,
    'the lingering stream is still aborted to unstick a held-open connection',
  );
  assert.deepEqual(
    timer.windows,
    [999, 30],
    'the window switches from inactivity to grace the moment finish is seen',
  );
});

test('watchdog: a mid-read throw propagates so the retry kernel classifies it', async () => {
  const boom = Object.assign(new Error('mid-stream boom'), { statusCode: 429 });
  const stream: AsyncIterable<{ type: string }> = {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(boom) };
    },
  };
  await assert.rejects(
    consumeStreamWithWatchdog(
      stream,
      { onPart: () => {}, isFinish: isFinishPart, abort: () => {} },
      { inactivityMs: 500, graceMs: 500, timer: recordingTimer().factory },
    ),
    (err: unknown) => err === boom,
  );
});

// A raw stream that replays `chunks` then never closes — a provider that goes silent. The generic T is
// pinned to LanguageModelV3StreamPart by MockLanguageModelV3's contextual doStream type, so the inline
// chunk literals are checked exactly as simulateReadableStream's are.
function neverClosingStream<T>(chunks: readonly T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
  });
}

// Streams a couple of assistant deltas then goes silent on the first call; streams a full submit on the
// next — proves the watchdog aborts the stall and re-runs the stream once to recover.
function stallThenRecoverModel(input: string): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stream: neverClosingStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'working' },
          ]),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'submit', input },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: emptyUsage(),
            },
          ],
        }),
      };
    },
  });
}

test('streaming watchdog: a mid-stream stall aborts and re-runs the stream once, then recovers (slice 07)', async () => {
  const model = stallThenRecoverModel(JSON.stringify({ n: 4 }));
  const agent = createSubagent(
    {
      model,
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStream: () => {},
      // Small inactivity fires on the first stream's silence; a large grace lets the recovery stream
      // (which reaches submit) drain normally rather than tripping the post-submit window.
      streamWatchdog: { inactivityMs: 50, graceMs: 5_000 },
    },
    12,
  );
  const { result } = await runSubagent(agent, 'go');
  assert.equal(model.doStreamCalls.length, 2, 'the stalled stream was re-invoked exactly once');
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 4 } });
});

// Goes silent mid-stream on every call — the stall never recovers.
function alwaysStallModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: neverClosingStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'thinking' },
      ]),
    }),
  });
}

test('streaming watchdog: a persistent stall gives up after one retry with a StreamStallError (slice 07)', async () => {
  const model = alwaysStallModel();
  const agent = createSubagent(
    {
      model,
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStream: () => {},
      streamWatchdog: { inactivityMs: 40, graceMs: 40 },
    },
    12,
  );
  await assert.rejects(runSubagent(agent, 'go'), (err: unknown) => err instanceof StreamStallError);
  assert.equal(
    model.doStreamCalls.length,
    MAX_STREAM_STALL_RETRIES + 1,
    'one original + one retry, then a hard stop — not an unbounded loop',
  );
});

test('isRetryableProviderError: a StreamStallError is never retried by the provider kernel (slice 07)', () => {
  // The watchdog already spent its one retry, and past submit a re-run would duplicate a completed
  // coding step — so the kernel must not multiply a StreamStallError.
  assert.equal(isRetryableProviderError(new StreamStallError('stalled')), false);
});

test('streaming watchdog: a clean finish drains without a retry (slice 07)', async () => {
  const model = streamingSubmitModel(['Hi'], JSON.stringify({ n: 5 }));
  const agent = createSubagent(
    {
      model,
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStream: () => {},
      streamWatchdog: { inactivityMs: 5_000, graceMs: 5_000 },
    },
    12,
  );
  const { result } = await runSubagent(agent, 'go');
  assert.equal(model.doStreamCalls.length, 1, 'a clean finish is never retried');
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 5 } });
});

// Emits a full submit + finish, then holds the connection open (never closes) — a provider that lingers
// after the coding step is already complete.
function finishThenLingerModel(input: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: neverClosingStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'done' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'submit', input },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
        },
      ]),
    }),
  });
}

test('streaming watchdog: a stream that lingers past submit fails hard on the grace window — never a re-run (slice 07)', async () => {
  const model = finishThenLingerModel(JSON.stringify({ n: 8 }));
  const agent = createSubagent(
    {
      model,
      tools: {},
      systemPrompt: 'sys',
      submit: submitTool(OutSchema),
      onStream: () => {},
      // Huge inactivity window so only the grace window can fire; a completed step must never re-run.
      streamWatchdog: { inactivityMs: 10_000, graceMs: 40 },
    },
    12,
  );
  await assert.rejects(runSubagent(agent, 'go'), (err: unknown) => err instanceof StreamStallError);
  assert.equal(
    model.doStreamCalls.length,
    1,
    'a finished coding step is never re-run — no duplicate PR, even when the stream will not close',
  );
});

// --- callWithStepTimeout (translate abort → named timeout) ---

test('callWithStepTimeout: returns the value when the call resolves', async () => {
  const out = await callWithStepTimeout(async () => 7, { stepMs: 1000 });
  assert.equal(out, 7);
});

test('callWithStepTimeout: translates an abort error into a StepTimeoutError naming the bound', async () => {
  const abort = new DOMException('This operation was aborted', 'AbortError');
  await assert.rejects(
    callWithStepTimeout(() => Promise.reject(abort), { stepMs: 900_000 }),
    (err: unknown) => {
      assert.ok(err instanceof StepTimeoutError);
      assert.match((err as Error).message, /900000 ms/);
      assert.equal((err as Error).cause, abort, 'retains the original abort as cause');
      return true;
    },
  );
});

test('callWithStepTimeout: a non-abort error propagates unchanged', async () => {
  const boom = new Error('provider 500');
  await assert.rejects(
    callWithStepTimeout(() => Promise.reject(boom), { stepMs: 1000 }),
    (err: unknown) => err === boom,
  );
});

// --- transient-provider retry (callWithRetry / isRetryableProviderError) ---

test('isRetryableProviderError: transient statuses and messages are retryable', () => {
  assert.equal(isRetryableProviderError({ statusCode: 429 }), true, '429 rate limit');
  assert.equal(isRetryableProviderError({ status: 503 }), true, '503 unavailable');
  assert.equal(isRetryableProviderError({ response: { status: 529 } }), true, '529 overloaded');
  assert.equal(isRetryableProviderError(new Error('Rate limit exceeded')), true);
  assert.equal(isRetryableProviderError(new Error('The engine is overloaded')), true);
  // Kimi's coding endpoint returns this exact phrasing for a rate-limit.
  assert.equal(
    isRetryableProviderError(new Error('Not found the model k3 or Permission denied')),
    true,
  );
  assert.equal(isRetryableProviderError(new Error('socket hang up')), true);
});

test('isRetryableProviderError: deadlines, aborts and real 4xx are NOT retryable', () => {
  assert.equal(isRetryableProviderError(new StepTimeoutError('deadline')), false);
  assert.equal(
    isRetryableProviderError(new DOMException('aborted', 'AbortError')),
    false,
    'explicit abort',
  );
  assert.equal(isRetryableProviderError({ statusCode: 400 }), false, 'bad request');
  assert.equal(isRetryableProviderError({ statusCode: 401 }), false, 'auth failure');
  assert.equal(isRetryableProviderError(new Error('schema validation failed')), false);
});

test('callWithRetry: retries a transient error then succeeds, with the escalating backoff', async () => {
  const delays: number[] = [];
  let calls = 0;
  const out = await callWithRetry(
    async () => {
      calls += 1;
      if (calls < 4) throw new Error('rate limit hit');
      return 'ok';
    },
    { sleep: async (ms) => void delays.push(ms) },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 4, 'failed 3 times, succeeded on the 4th attempt');
  assert.deepEqual(delays, [1_000, 5_000, 10_000], 'backoff 1s, 5s, 10s before attempts 2..4');
});

test('callWithRetry: gives up after maxRetries and throws the last transient error', async () => {
  let calls = 0;
  const err = await callWithRetry(
    async () => {
      calls += 1;
      throw new Error(`overloaded ${calls}`);
    },
    { maxRetries: 3, sleep: async () => {} },
  ).then(
    () => null,
    (e: Error) => e,
  );
  assert.equal(calls, 4, '1 initial + 3 retries');
  assert.match(err?.message ?? '', /overloaded 4/, 'the final attempt error is surfaced');
});

test('callWithRetry: a non-transient error is thrown immediately, no retry', async () => {
  let calls = 0;
  await assert.rejects(
    callWithRetry(
      async () => {
        calls += 1;
        throw new Error('bad request: invalid schema');
      },
      { sleep: async () => {} },
    ),
    /bad request/,
  );
  assert.equal(calls, 1, 'non-transient errors are not retried');
});

test('defaultRetryDelayMs: 1s then +5s per attempt', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(defaultRetryDelayMs),
    [1_000, 5_000, 10_000, 15_000, 20_000],
  );
});

// --- Retry-After parsing + onRetry visibility (slice 01b) ---

// An Error carrying provider-SDK error fields (statusCode, headers, body) — the shape callWithRetry
// classifies and parses. A real Error avoids throw-literal lint while still carrying the fields.
function providerError(props: Record<string, unknown>): Error {
  return Object.assign(new Error('provider error'), props);
}

test('parseRetryAfterMs: a Retry-After header in seconds → milliseconds', () => {
  assert.equal(
    parseRetryAfterMs(providerError({ responseHeaders: { 'retry-after': '15' } })),
    15_000,
  );
});

test('parseRetryAfterMs: a retry-after-ms header is taken as-is', () => {
  assert.equal(
    parseRetryAfterMs(providerError({ responseHeaders: { 'retry-after-ms': '2500' } })),
    2_500,
  );
});

test('parseRetryAfterMs: an HTTP-date Retry-After → the delay until that instant', () => {
  const ms = parseRetryAfterMs(
    providerError({
      responseHeaders: { 'retry-after': new Date(Date.now() + 90_000).toUTCString() },
    }),
  );
  assert.ok(ms !== undefined && ms > 85_000 && ms <= 90_000, `expected ~90s, got ${ms}`);
});

test('parseRetryAfterMs: reads a fetch Headers instance via .get, case-insensitively', () => {
  const err = providerError({ response: { headers: new Headers({ 'Retry-After': '3' }) } });
  assert.equal(parseRetryAfterMs(err), 3_000);
});

test('parseRetryAfterMs: parses a "try again in Ns" hint from the message or raw body', () => {
  assert.equal(
    parseRetryAfterMs(providerError({ message: 'Rate limited. Please try again in 12s.' })),
    12_000,
  );
  assert.equal(
    parseRetryAfterMs(providerError({ message: 'slow down', responseBody: 'retry in 250 ms' })),
    250,
  );
});

test('parseRetryAfterMs: undefined when no Retry-After is present or the value is junk', () => {
  assert.equal(parseRetryAfterMs(new Error('overloaded')), undefined);
  assert.equal(
    parseRetryAfterMs(providerError({ responseHeaders: { 'retry-after': 'soon' } })),
    undefined,
  );
  assert.equal(parseRetryAfterMs({}), undefined);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('boom'), undefined);
});

test('callWithRetry: honors a parsed Retry-After for the delay and reports it via onRetry', async () => {
  const delays: number[] = [];
  const infos: RetryInfo[] = [];
  let calls = 0;
  const out = await callWithRetry(
    async () => {
      calls += 1;
      if (calls === 1)
        throw providerError({ statusCode: 429, responseHeaders: { 'retry-after': '7' } });
      return 'ok';
    },
    { sleep: async (ms) => void delays.push(ms), onRetry: (info) => void infos.push(info) },
  );
  assert.equal(out, 'ok');
  assert.deepEqual(delays, [7_000], 'honored Retry-After (7s), not the 1s backoff');
  assert.deepEqual(infos, [
    { attempt: 1, maxAttempts: DEFAULT_LLM_MAX_RETRIES, delayMs: 7_000, reason: 'HTTP 429' },
  ]);
});

test('callWithRetry: onRetry reports the escalating backoff and cause when no Retry-After is present', async () => {
  const infos: RetryInfo[] = [];
  let calls = 0;
  await callWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('overloaded');
      return 'ok';
    },
    { sleep: async () => {}, onRetry: (info) => void infos.push(info) },
  );
  assert.deepEqual(
    infos.map((i) => i.delayMs),
    [1_000, 5_000],
    'onRetry saw the backoff schedule',
  );
  assert.deepEqual(
    infos.map((i) => i.attempt),
    [1, 2],
  );
  assert.equal(infos[0]?.reason, 'overloaded');
  assert.equal(infos[0]?.maxAttempts, DEFAULT_LLM_MAX_RETRIES);
});

test('callWithRetry: caps an oversized Retry-After at the five-minute bound', async () => {
  const delays: number[] = [];
  let calls = 0;
  await callWithRetry(
    async () => {
      calls += 1;
      if (calls === 1)
        throw providerError({ statusCode: 429, responseHeaders: { 'retry-after': '99999' } });
      return 'ok';
    },
    { sleep: async (ms) => void delays.push(ms) },
  );
  assert.deepEqual(delays, [300_000], 'honored but capped at 5 minutes');
});

test('callWithRetry: a throwing onRetry never breaks the retry loop', async () => {
  let calls = 0;
  const out = await callWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('rate limit hit');
      return 'ok';
    },
    {
      sleep: async () => {},
      onRetry: () => {
        throw new Error('sink boom');
      },
    },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 2, 'retry proceeded despite the throwing sink');
});

test('callWithStepTimeout: threads retry options (onRetry + sleep) through to the kernel', async () => {
  const infos: RetryInfo[] = [];
  const delays: number[] = [];
  let calls = 0;
  const out = await callWithStepTimeout(
    async () => {
      calls += 1;
      if (calls === 1)
        throw providerError({ statusCode: 503, responseHeaders: { 'retry-after': '4' } });
      return 42;
    },
    { stepMs: 1_000 },
    { sleep: async (ms) => void delays.push(ms), onRetry: (info) => void infos.push(info) },
  );
  assert.equal(out, 42);
  assert.deepEqual(delays, [4_000], 'the parsed Retry-After reached the kernel sleep');
  assert.equal(infos[0]?.reason, 'HTTP 503');
  assert.equal(infos[0]?.delayMs, 4_000);
});

test('callWithStepTimeout: timeout undefined is a pass-through — a raw abort is NOT translated', async () => {
  const abort = new DOMException('This operation was aborted', 'AbortError');
  await assert.rejects(
    callWithStepTimeout(() => Promise.reject(abort), undefined),
    (err: unknown) => err === abort,
  );
});

// --- submittedOutput (typed, never throws) ---

test('submittedOutput: ok on a valid submit call', () => {
  const result = { steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: { n: 7 } }] }] };
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 7 } });
});

test('submittedOutput: no-submission when submit was never called', () => {
  const result = { steps: [{ toolCalls: [{ toolName: 'grep', input: {} }] }] };
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: false, reason: 'no-submission' });
});

test('submittedOutput: invalid (with issues) on a schema-mismatched submit — never throws', () => {
  const result = { steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: { n: 'nope' } }] }] };
  const out = submittedOutput(result, OutSchema);
  assert.equal(out.ok, false);
  if (!out.ok && out.reason === 'invalid') {
    assert.ok(out.issues.length >= 1);
    assert.equal(out.issues[0]?.path[0], 'n');
  } else {
    assert.fail(`expected invalid, got ${JSON.stringify(out)}`);
  }
});

test('submittedOutput: invalid on a raw-string input left by a JSON-parse failure', () => {
  // When the tool args do not parse as JSON, the SDK keeps the raw string as `input`.
  const result = { steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: '{ not json' }] }] };
  const out = submittedOutput(result, OutSchema);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'invalid');
});

test('submittedOutput: salvages a stringified-JSON submit that validates (issue #185)', () => {
  // The live failure shape: submit("{\"n\": 7}") instead of submit({ n: 7 }).
  const result = { steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: '{"n": 7}' }] }] };
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 7 } });
});

test('submittedOutput: salvages a ```-fenced JSON submit (issue #185)', () => {
  const result = {
    steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: '```json\n{"n": 7}\n```' }] }],
  };
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 7 } });
});

test('submittedOutput: a stringified payload that parses but fails the schema stays invalid, with the parsed value issues (issue #185)', () => {
  const result = {
    steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: '{"n": "nope"}' }] }],
  };
  const out = submittedOutput(result, OutSchema);
  assert.equal(out.ok, false);
  if (!out.ok && out.reason === 'invalid') {
    assert.equal(
      out.issues[0]?.path[0],
      'n',
      'issues reflect the parsed object, not the raw string',
    );
  } else {
    assert.fail(`expected invalid, got ${JSON.stringify(out)}`);
  }
});

// --- runWithSchemaRetry ---

test('runWithSchemaRetry: corrects an invalid submit on retry; corrective message quotes the Zod issues', async () => {
  const s = scriptedModel((idx) =>
    idx === 0
      ? { submit: JSON.stringify({ n: 'not-a-number' }) }
      : { submit: JSON.stringify({ n: 42 }) },
  );
  const out = await runWithSchemaRetry(agentFor(s.model), OutSchema, 'do it');
  assert.deepEqual(out, { ok: true, value: { n: 42 } });
  assert.equal(s.calls(), 2, 'exactly one retry');
  // The corrective user message on the second call names the submit tool and quotes the issue.
  assert.match(s.promptAt(1), new RegExp(SUBMIT_TOOL_NAME));
  assert.match(s.promptAt(1), /expected number|Invalid input/i);
});

test('runWithSchemaRetry: exhausts after maxRetries and returns the last typed invalid failure', async () => {
  const s = scriptedModel(() => ({ submit: JSON.stringify({ n: 'x' }) })); // never valid
  const out = await runWithSchemaRetry(agentFor(s.model), OutSchema, 'do it', { maxRetries: 2 });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'invalid');
  assert.equal(s.calls(), 3, 'initial attempt + 2 retries');
});

test('runWithSchemaRetry: a run that never submits is retried, then returned as no-submission', async () => {
  const s = scriptedModel(() => ({ noSubmit: true }));
  const out = await runWithSchemaRetry(agentFor(s.model), OutSchema, 'do it', { maxRetries: 1 });
  assert.deepEqual(out, { ok: false, reason: 'no-submission' });
  assert.equal(s.calls(), 2, 'initial attempt + 1 retry');
});

test('runWithSchemaRetry: a first-try valid submit returns ok with no retry', async () => {
  const s = scriptedModel(() => ({ submit: JSON.stringify({ n: 5 }) }));
  const out = await runWithSchemaRetry(agentFor(s.model), OutSchema, 'do it');
  assert.deepEqual(out, { ok: true, value: { n: 5 } });
  assert.equal(s.calls(), 1);
});

// --- runSubagent / continueSubagent (issue #107) ---

test('continueSubagent: replays all prior messages then the follow-up; a fresh spawn shares none', async () => {
  const s = scriptedModel(() => ({ submit: JSON.stringify({ n: 1 }) }));
  const { handle } = await runSubagent(agentFor(s.model), 'FIRST-PROMPT');
  await continueSubagent(handle, 'FOLLOW-UP');
  // Call 0 (the fresh run) sees only FIRST-PROMPT.
  assert.match(s.promptAt(0), /FIRST-PROMPT/);
  assert.doesNotMatch(s.promptAt(0), /FOLLOW-UP/);
  // Call 1 (the continuation) replays FIRST-PROMPT and the retained submit, then FOLLOW-UP.
  assert.match(s.promptAt(1), /FIRST-PROMPT/);
  assert.match(s.promptAt(1), new RegExp(SUBMIT_TOOL_NAME));
  assert.match(s.promptAt(1), /FOLLOW-UP/);
  // A fresh spawn on a different model shares nothing.
  const s2 = scriptedModel(() => ({ submit: JSON.stringify({ n: 2 }) }));
  await runSubagent(agentFor(s2.model), 'OTHER');
  assert.doesNotMatch(s2.promptAt(0), /FIRST-PROMPT|FOLLOW-UP/);
});

test('continueSubagent: submittedOutput reflects only the new run — a submit only in retained history yields none', async () => {
  const subs = [{ n: 1 }, { n: 2 }];
  const s = scriptedModel((idx) =>
    idx < 2 ? { submit: JSON.stringify(subs[idx]) } : { noSubmit: true },
  );
  const agent = agentFor(s.model);
  const run0 = await runSubagent(agent, 'go');
  assert.deepEqual(submittedOutput(run0.result, OutSchema), { ok: true, value: { n: 1 } });
  const run1 = await continueSubagent(run0.handle, 'again');
  assert.deepEqual(submittedOutput(run1.result, OutSchema), { ok: true, value: { n: 2 } });
  // Run 2 does not submit; the earlier submits live in retained history but not in this run's steps.
  const run2 = await continueSubagent(run1.handle, 'and again');
  assert.deepEqual(submittedOutput(run2.result, OutSchema), { ok: false, reason: 'no-submission' });
});

test('continueSubagent: two successive continuations chain through returned handles', async () => {
  const s = scriptedModel(() => ({ submit: JSON.stringify({ n: 7 }) }));
  const run0 = await runSubagent(agentFor(s.model), 'P0');
  const run1 = await continueSubagent(run0.handle, 'P1');
  const run2 = await continueSubagent(run1.handle, 'P2');
  // The third call's request carries every earlier user message in order.
  const p2 = s.promptAt(2);
  assert.ok(p2.indexOf('P0') < p2.indexOf('P1'));
  assert.ok(p2.indexOf('P1') < p2.indexOf('P2'));
  assert.equal(s.calls(), 3);
  // The final handle keeps growing.
  assert.ok(run2.handle.messages.length > run1.handle.messages.length);
});

test('continueSubagent: a handle whose messages were externally reshaped (compacted) continues from those as-is', async () => {
  const s = scriptedModel(() => ({ submit: JSON.stringify({ n: 9 }) }));
  const agent = agentFor(s.model);
  const compacted = { agent, messages: [{ role: 'user' as const, content: 'COMPACTED-SUMMARY' }] };
  await continueSubagent(compacted, 'CONTINUE-FROM-SUMMARY');
  assert.match(s.promptAt(0), /COMPACTED-SUMMARY/);
  assert.match(s.promptAt(0), /CONTINUE-FROM-SUMMARY/);
});

// --- formatSubmitIssues ---

test('formatSubmitIssues: renders "path: message", joined', () => {
  const r = OutSchema.safeParse({ n: 'x' });
  assert.equal(r.success, false);
  if (!r.success) assert.match(formatSubmitIssues(r.error.issues), /n: /);
});

// The envelope shapes that used to reach the caller as an undiagnosable
// `<root>: expected object, received string`. On the Planner/Worker/Reviewer surfaces that is not a
// degraded result — they have no fallback, so a missed envelope blocks a PR group outright.

test('submittedOutput: salvages a DOUBLE-encoded JSON submit', () => {
  const inner = JSON.stringify({ n: 7 });
  const result = {
    steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: JSON.stringify(inner) }] }],
  };
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 7 } });
});

test('submittedOutput: salvages a fence with no newline before the close', () => {
  // The strict anchored form required `\n``` `; this shape missed and read as a plain string.
  const result = {
    steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: '```json\n{"n": 7}```' }] }],
  };
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 7 } });
});

test('submittedOutput: salvages a fenced submit followed by prose', () => {
  const result = {
    steps: [
      {
        toolCalls: [
          {
            toolName: SUBMIT_TOOL_NAME,
            input: '```json\n{"n": 7}\n```\nHope that helps!',
          },
        ],
      },
    ],
  };
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 7 } });
});

test('submittedOutput: salvages an object embedded in narration', () => {
  const result = {
    steps: [
      {
        toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: 'Here is the answer:\n{"n": 7}\nDone.' }],
      },
    ],
  };
  assert.deepEqual(submittedOutput(result, OutSchema), { ok: true, value: { n: 7 } });
});

test('submittedOutput: a brace inside a string value cannot truncate the salvage', () => {
  // Why the scan is string- and escape-aware: a PR body full of prose and braces would otherwise
  // end the object early and salvage a fragment.
  const payload = JSON.stringify({ n: 7, note: 'a } brace and a \\" quote' });
  const result = {
    steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: `text before ${payload} after` }] }],
  };
  const out = submittedOutput(result, LooseSchema);
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.value.note, 'a } brace and a \\" quote');
});

test('submittedOutput: recovery never widens the schema — a parsed but invalid payload stays invalid', () => {
  const result = {
    steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: '```json\n{"n": "nope"}\n```' }] }],
  };
  const out = submittedOutput(result, OutSchema);
  assert.equal(out.ok, false);
  if (!out.ok && out.reason === 'invalid') assert.equal(out.issues[0]?.path[0], 'n');
  else assert.fail(`expected invalid, got ${JSON.stringify(out)}`);
});

test('submittedOutput: pure prose is still invalid, not salvaged', () => {
  const result = {
    steps: [{ toolCalls: [{ toolName: SUBMIT_TOOL_NAME, input: 'I could not do it, sorry.' }] }],
  };
  const out = submittedOutput(result, OutSchema);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, 'invalid');
});

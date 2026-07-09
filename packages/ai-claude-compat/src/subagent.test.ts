import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolLoopAgent, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import {
  callWithStepTimeout,
  composeSystemPrompt,
  createSubagent,
  formatSubmitIssues,
  runWithSchemaRetry,
  StepTimeoutError,
  SUBMIT_TOOL_NAME,
  submittedOutput,
} from './subagent.ts';

const OutSchema = z.object({ n: z.number() });

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

// --- composeSystemPrompt (unchanged) ---

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

// --- createSubagent (submit-contract shape) ---

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

// --- formatSubmitIssues ---

test('formatSubmitIssues: renders "path: message", joined', () => {
  const r = OutSchema.safeParse({ n: 'x' });
  assert.equal(r.success, false);
  if (!r.success) assert.match(formatSubmitIssues(r.error.issues), /n: /);
});

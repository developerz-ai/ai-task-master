import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ToolLoopAgent, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import {
  callWithStepTimeout,
  composeSystemPrompt,
  continueSubagent,
  createSubagent,
  formatSubmitIssues,
  runSubagent,
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

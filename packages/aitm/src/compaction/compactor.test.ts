import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StepTimeoutError } from '@developerz.ai/ai-claude-compat';
import { MockLanguageModelV3 } from 'ai/test';
import type { ModelLimits, ModelLimitsLookup } from '../openrouter/model-limits.ts';
import {
  Compactor,
  effectiveInputTokens,
  type LiveContextSize,
  safeStringify,
} from './compactor.ts';

// The usage-grounded live-context size fed to shouldCompact. `estimatedInputTokens` is the char
// estimate over the whole message array (always present); `reported` carries the provider's exact
// last-call prompt tokens + a char estimate of the delta appended since.
function estimated(estimatedInputTokens: number): LiveContextSize {
  return { estimatedInputTokens };
}
function grounded(
  lastCallInputTokens: number,
  sinceTokens: number,
  estimatedInputTokens: number,
): LiveContextSize {
  return { estimatedInputTokens, reported: { lastCallInputTokens, sinceTokens } };
}

// A summarizer that only settles by rejecting when its abortSignal fires — proves the per-step
// deadline is armed (issue #129).
function stallingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(
            opts.abortSignal?.reason instanceof Error
              ? opts.abortSignal.reason
              : new DOMException('This operation was aborted', 'AbortError'),
          ),
        );
      }),
  });
}

function stubLimits(contextLength: number, modelId = 'openai/gpt-5'): ModelLimitsLookup {
  return {
    forModel: async (id: string): Promise<ModelLimits> => ({ modelId: id, contextLength }),
    preload: async () => {},
  } satisfies ModelLimitsLookup;
}

function summarizerReturning(text: string): {
  model: MockLanguageModelV3;
  callPrompts: () => string[];
} {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      // Capture the rendered user prompt for assertions.
      const userMessages = options.prompt.filter((m) => m.role === 'user');
      const last = userMessages[userMessages.length - 1];
      if (last && last.role === 'user') {
        const parts = Array.isArray(last.content) ? last.content : [];
        for (const part of parts) {
          if (part.type === 'text') prompts.push(part.text);
        }
      }
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  return { model, callPrompts: () => prompts };
}

test('Compactor is constructible', () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
  });
  assert.ok(c instanceof Compactor);
});

test('shouldCompact returns skip just below the 0.7 default threshold', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
  });
  const decision = await c.shouldCompact('openai/gpt-5', estimated(69_999));
  assert.deepEqual(decision, { kind: 'skip' });
});

test('shouldCompact returns compact at exactly the 0.7 default threshold', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
  });
  const decision = await c.shouldCompact('openai/gpt-5', estimated(70_000));
  assert.deepEqual(decision, { kind: 'compact', keepLastSteps: 6, contextLength: 100_000 });
});

test('shouldCompact returns compact above the threshold and carries keepLastSteps override', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
    keepLastSteps: 3,
  });
  const decision = await c.shouldCompact('openai/gpt-5', estimated(99_999));
  assert.deepEqual(decision, { kind: 'compact', keepLastSteps: 3, contextLength: 100_000 });
});

test('shouldCompact skips when contextLength is zero, negative, or non-finite', async () => {
  for (const contextLength of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const c = new Compactor({
      summarizer: new MockLanguageModelV3(),
      limits: stubLimits(contextLength),
    });
    assert.deepEqual(await c.shouldCompact('openai/gpt-5', estimated(1_000_000)), { kind: 'skip' });
  }
});

test('shouldCompact skips when liveInputTokens is negative or non-finite', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
  });
  for (const tokens of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(await c.shouldCompact('openai/gpt-5', estimated(tokens)), { kind: 'skip' });
  }
});

test('shouldCompact honors a custom threshold', async () => {
  const c = new Compactor({
    summarizer: new MockLanguageModelV3(),
    limits: stubLimits(100_000),
    threshold: 0.5,
  });
  assert.deepEqual(await c.shouldCompact('openai/gpt-5', estimated(49_999)), { kind: 'skip' });
  assert.deepEqual(await c.shouldCompact('openai/gpt-5', estimated(50_000)), {
    kind: 'compact',
    keepLastSteps: 6,
    contextLength: 100_000,
  });
});

test('effectiveInputTokens: no reported usage → the whole-array char estimate', () => {
  assert.equal(effectiveInputTokens(estimated(1234)), 1234);
});

test('effectiveInputTokens: reported present → last-call tokens + delta since (preferred over estimate)', () => {
  // Grounded 1000 + 200 = 1200 exceeds the message-only estimate 500 (which omits system + tools).
  assert.equal(effectiveInputTokens(grounded(1000, 200, 500)), 1200);
});

test('effectiveInputTokens: floors at the estimate when the reported figure under-reports', () => {
  // Post-compaction: last call was the small compacted request (100 + 50) but the live array reverted
  // to the full history (estimate 900) → the estimate floor wins so a needed compaction is not skipped.
  assert.equal(effectiveInputTokens(grounded(100, 50, 900)), 900);
});

test('shouldCompact: usage-grounded tokens cross the threshold when the char estimate alone stays under', async () => {
  const c = new Compactor({ summarizer: new MockLanguageModelV3(), limits: stubLimits(100_000) });
  // Estimate 60k is below the 70k trigger, but the provider counted 68k for the last call and 5k of
  // messages were appended since → grounded 73k ≥ 70k → compact (the char estimate alone missed the
  // system prompt + tool schemas the provider billed).
  assert.deepEqual(await c.shouldCompact('openai/gpt-5', grounded(68_000, 5_000, 60_000)), {
    kind: 'compact',
    keepLastSteps: 6,
    contextLength: 100_000,
  });
  // Same estimate, but the grounded figure also stays under → skip (no over-eager compaction).
  assert.deepEqual(await c.shouldCompact('openai/gpt-5', grounded(60_000, 1_000, 60_000)), {
    kind: 'skip',
  });
});

test('shouldCompact: a post-compaction under-report is floored by the estimate → still compacts', async () => {
  const c = new Compactor({ summarizer: new MockLanguageModelV3(), limits: stubLimits(100_000) });
  // The last (compacted) call reported a tiny 5k input, but the reverted live array estimates 80k ≥
  // 70k → the estimate floor forces the compaction the small reported figure would otherwise skip.
  assert.deepEqual(await c.shouldCompact('openai/gpt-5', grounded(5_000, 500, 80_000)), {
    kind: 'compact',
    keepLastSteps: 6,
    contextLength: 100_000,
  });
});

test('compact returns the summarizer text and embeds the JSON of older messages', async () => {
  const { model, callPrompts } = summarizerReturning('- did X\n- decided Y');
  const c = new Compactor({ summarizer: model, limits: stubLimits(100_000) });
  const older = [
    { role: 'user', content: 'Goal: refactor parser' },
    { role: 'assistant', content: 'Plan: split into lexer + parser' },
  ];
  const summary = await c.compact(older);
  assert.equal(summary, '- did X\n- decided Y');

  const prompts = callPrompts();
  assert.equal(prompts.length, 1);
  const sent = prompts[0] ?? '';
  assert.match(sent, /bulleted note/);
  assert.ok(sent.includes(JSON.stringify(older)), 'prompt must embed JSON of older messages');
  assert.ok(!sent.includes('<previous-summary>'), 'fresh summary carries no anchor block');
});

test('compact updates in place when given a prior summary — anchors it and prompts for the sections', async () => {
  const { model, callPrompts } = summarizerReturning('- Objective: ship parser\n- Done: lexer');
  const c = new Compactor({ summarizer: model, limits: stubLimits(100_000) });
  const newer = [
    { role: 'assistant', content: 'Finished the lexer; wrote lexer.test.ts' },
    { role: 'user', content: 'now do the parser' },
  ];
  const prior = '- Objective: ship parser\n- In progress: lexer';
  const summary = await c.compact(newer, prior);
  assert.equal(summary, '- Objective: ship parser\n- Done: lexer');

  const prompts = callPrompts();
  assert.equal(prompts.length, 1);
  const sent = prompts[0] ?? '';
  assert.ok(sent.includes('<previous-summary>'), 'wraps the prior summary in an anchor block');
  assert.ok(sent.includes(prior), 'passes the previous summary verbatim');
  assert.ok(sent.includes(JSON.stringify(newer)), 'embeds JSON of the newer messages to fold in');
  for (const section of ['objective', 'done', 'in progress', 'files', 'next']) {
    assert.match(sent, new RegExp(section, 'i'), `prompt requests the ${section} section`);
  }
});

test('compact treats a blank prior summary as none — falls back to the fresh prompt', async () => {
  const { model, callPrompts } = summarizerReturning('- did X');
  const c = new Compactor({ summarizer: model, limits: stubLimits(100_000) });
  await c.compact([{ role: 'user', content: 'Goal: refactor parser' }], '   \n\t  ');
  const sent = callPrompts()[0] ?? '';
  assert.ok(!sent.includes('<previous-summary>'), 'blank anchor is ignored');
  assert.match(sent, /bulleted note/);
});

test('compact arms the per-step deadline and surfaces a StepTimeoutError on a stalled summarizer (issue #129)', async () => {
  const c = new Compactor({
    summarizer: stallingModel(),
    limits: stubLimits(100_000),
    timeout: { stepMs: 40 },
  });
  await assert.rejects(
    c.compact([{ role: 'user', content: 'x' }]),
    (err: unknown) => err instanceof StepTimeoutError,
  );
});

test('compact returns undefined when the summarizer text is empty', async () => {
  const { model } = summarizerReturning('');
  const c = new Compactor({ summarizer: model, limits: stubLimits(100_000) });
  const summary = await c.compact([{ role: 'user', content: 'Goal: refactor parser' }]);
  assert.equal(summary, undefined);
});

test('compact returns undefined when the summarizer text is whitespace-only', async () => {
  const { model } = summarizerReturning('   \n\t  ');
  const c = new Compactor({ summarizer: model, limits: stubLimits(100_000) });
  const summary = await c.compact([{ role: 'user', content: 'Goal: refactor parser' }]);
  assert.equal(summary, undefined);
});

test('compact survives circular references in messages', async () => {
  const { model } = summarizerReturning('- summary');
  const c = new Compactor({ summarizer: model, limits: stubLimits(100_000) });
  type CyclicMessage = { role: string; content: string; self?: unknown };
  const a: CyclicMessage = { role: 'user', content: 'first' };
  const b: CyclicMessage = { role: 'assistant', content: 'second' };
  a.self = b;
  b.self = a; // cycle: a.self -> b.self -> a
  const summary = await c.compact([a, b]);
  assert.equal(summary, '- summary');
});

// Issue #251: same false-cycle family as Logger.redact — a shared reference must serialize
// normally; only a value that is its own ancestor is a cycle.
test('safeStringify keeps shared references and replaces only true cycles', () => {
  const shared = { reused: true };
  const dag = { a: shared, b: shared };
  assert.deepEqual(JSON.parse(safeStringify(dag)), { a: { reused: true }, b: { reused: true } });

  const node: Record<string, unknown> = { name: 'root' };
  node.self = node;
  assert.deepEqual(JSON.parse(safeStringify(node)), { name: 'root', self: '[CYCLE]' });
});

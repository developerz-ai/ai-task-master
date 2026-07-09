import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { ModelLimitsLookup } from '../openrouter/model-limits.ts';
import { buildCompactionStep, type CompactorLike } from './compaction-step.ts';
import { type CompactionDecision, Compactor } from './compactor.ts';

// A prepareStep `steps` entry: only the field the builder reads for the tail cut — the count of
// response messages the step produced (sizing is off the live `messages`, not step usage).
function step(responseMsgCount: number) {
  return {
    response: {
      messages: Array.from({ length: responseMsgCount }, (_, i) => ({
        role: 'assistant',
        content: `resp-${i}`,
      })),
    },
  };
}

function msg(role: string, content: string): { role: string; content: string } {
  return { role, content };
}

function msgs(n: number): Array<{ role: string; content: string }> {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? 'tool' : 'assistant',
    content: `m${i}`,
  }));
}

// prepareStep input — only the small structural slice the builder reads. The builder's returned
// function accepts the full SDK options object; we pass this partial (unchecked in tests).
function prepInput(steps: unknown[], messages: unknown[]) {
  return { steps, stepNumber: steps.length, model: {}, messages, experimental_context: undefined };
}

function stubCompactor(opts: {
  decision: CompactionDecision;
  summary?: string;
  onCompact?: (older: readonly unknown[]) => void;
  shouldThrows?: boolean;
  compactThrows?: boolean;
}): CompactorLike {
  return {
    shouldCompact: async () => {
      if (opts.shouldThrows) throw new Error('lookup boom');
      return opts.decision;
    },
    compact: async (older) => {
      opts.onCompact?.(older);
      if (opts.compactThrows) throw new Error('summarizer boom');
      return opts.summary ?? 'SUMMARY';
    },
  };
}

function captureLogger(events: Array<Record<string, unknown>>) {
  const rec =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      events.push({ level, msg, ...(fields ?? {}) });
    };
  return {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    status: () => {},
    flush: async () => {},
  };
}

test('buildCompactionStep: above threshold → [summary user msg, ...keepLastSteps tail], cut at a step boundary', async () => {
  // 4 steps × 2 response messages = 8 step-messages, plus the initial user prompt = 9 total.
  const steps = [step(2), step(2), step(2), step(2)];
  const messages = [{ role: 'user', content: 'goal' }, ...msgs(8)];
  let compactedOlder: unknown[] = [];
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100_000 },
    summary: 'TIGHT SUMMARY',
    onCompact: (older) => {
      compactedOlder = older;
    },
  });
  const result = await buildCompactionStep({ compactor, modelId: 'openai/gpt-5' })(
    prepInput(steps, messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  // keepLastSteps=2 → last 2 steps carry 2+2=4 messages → tail = last 4; summary(1)+tail(4)=5.
  assert.equal(result.messages.length, 5);
  assert.equal(result.messages[0].role, 'user');
  assert.match(String(result.messages[0].content), /TIGHT SUMMARY/);
  assert.match(String(result.messages[0].content), /summarized to fit the context window/i);
  // Tail is the last 4 original messages verbatim (step boundary preserved).
  assert.deepEqual(result.messages.slice(1), messages.slice(messages.length - 4));
  // Older (summarized) = the first 5 messages (9 - 4).
  assert.equal(compactedOlder.length, 5);
});

test('buildCompactionStep sizes off the live messages via a real Compactor: large context compacts, small does not (issue #102)', async () => {
  // The override is not persisted across steps by the installed ai, so sizing must read the live
  // `messages` (the real to-be-sent context), not the last step's usage. A small window makes the
  // char-estimate cross 0.7 on a large message array and stay under it on a small one.
  const limits: ModelLimitsLookup = {
    forModel: async () => ({ modelId: 'm', contextLength: 100 }),
    preload: async () => {},
  };
  const summarizer = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'REAL SUMMARY' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
        totalTokens: 2,
      },
      warnings: [],
    }),
  });
  const build = buildCompactionStep({
    compactor: new Compactor({ summarizer, limits, keepLastSteps: 1 }),
    modelId: 'm',
  });

  // Small live context (~1 token) → stays under 0.7 → pass-through.
  const small = await build(prepInput([step(1)], [msg('user', 'hi'), msg('assistant', 'ok')]));
  assert.equal(small, undefined);

  // Large live context (~200 tokens vs a 100 window) → crosses 0.7 → real summarizer runs.
  const big = 'x'.repeat(400);
  const large = await build(
    prepInput([step(1), step(1)], [msg('user', big), msg('assistant', big), msg('tool', 'r')]),
  );
  assert.ok(large && Array.isArray(large.messages));
  assert.match(String(large.messages[0].content), /REAL SUMMARY/);
});

test('buildCompactionStep: below threshold → pass-through, summarizer never called', async () => {
  let compactCalls = 0;
  const compactor = stubCompactor({
    decision: { kind: 'skip' },
    onCompact: () => {
      compactCalls++;
    },
  });
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2)], msgs(2)),
  );
  assert.equal(result, undefined);
  assert.equal(compactCalls, 0);
});

test('buildCompactionStep: empty message array → pass-through (nothing to send yet)', async () => {
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100 },
  });
  assert.equal(
    await buildCompactionStep({ compactor, modelId: 'm' })(prepInput([], [])),
    undefined,
  );
});

test('buildCompactionStep: nothing older than the kept tail → pass-through', async () => {
  // One step produced all 3 messages; keepLastSteps covers it → older is empty.
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 6, contextLength: 100_000 },
  });
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(3)], msgs(3)),
  );
  assert.equal(result, undefined);
});

test('buildCompactionStep: threshold lookup failure → pass-through + warning (non-fatal)', async () => {
  const events: Array<Record<string, unknown>> = [];
  const compactor = stubCompactor({ decision: { kind: 'skip' }, shouldThrows: true });
  const result = await buildCompactionStep({
    compactor,
    modelId: 'm',
    logger: captureLogger(events),
  })(prepInput([step(2)], msgs(3)));
  assert.equal(result, undefined);
  assert.ok(
    events.some((e) => e.level === 'warn' && /threshold lookup failed/i.test(String(e.msg))),
  );
});

test('buildCompactionStep: summarizer failure → pass-through + warning (non-fatal)', async () => {
  const events: Array<Record<string, unknown>> = [];
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    compactThrows: true,
  });
  const result = await buildCompactionStep({
    compactor,
    modelId: 'm',
    logger: captureLogger(events),
  })(prepInput([step(2), step(2)], msgs(5)));
  assert.equal(result, undefined);
  assert.ok(events.some((e) => e.level === 'warn' && /summarizer failed/i.test(String(e.msg))));
});

test('buildCompactionStep: logs one structured event per compaction (model id, tokens, context length, kept steps)', async () => {
  const events: Array<Record<string, unknown>> = [];
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100_000 },
    summary: 'S',
  });
  await buildCompactionStep({ compactor, modelId: 'openai/gpt-5', logger: captureLogger(events) })(
    prepInput([step(2), step(2), step(2)], msgs(7)),
  );
  const log = events.find((e) => e.msg === 'compaction: compacted context');
  assert.ok(log, 'a compaction event was logged');
  assert.equal(log?.modelId, 'openai/gpt-5');
  // liveInputTokens is the estimate off the live messages — a positive number.
  assert.equal(typeof log?.liveInputTokens, 'number');
  assert.ok((log?.liveInputTokens as number) > 0);
  assert.equal(log?.contextLength, 100_000);
  assert.equal(log?.keptSteps, 2);
});

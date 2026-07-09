import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompactionStep } from './compaction-step.ts';
import type { Compactor } from './compactor.ts';

// A prepareStep `steps` entry: only the fields the builder reads (usage.inputTokens, the count of
// response messages produced in the step).
function step(inputTokens: number | undefined, responseMsgCount: number) {
  return {
    usage: { inputTokens },
    response: {
      messages: Array.from({ length: responseMsgCount }, (_, i) => ({
        role: 'assistant',
        content: `resp-${i}`,
      })),
    },
  };
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
  decision: unknown;
  summary?: string;
  onCompact?: (older: unknown[]) => void;
  shouldThrows?: boolean;
  compactThrows?: boolean;
}): Compactor {
  return {
    shouldCompact: async () => {
      if (opts.shouldThrows) throw new Error('lookup boom');
      return opts.decision;
    },
    compact: async (older: unknown[]) => {
      opts.onCompact?.(older);
      if (opts.compactThrows) throw new Error('summarizer boom');
      return opts.summary ?? 'SUMMARY';
    },
  } as unknown as Compactor;
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
  const steps = [step(90_000, 2), step(90_000, 2), step(90_000, 2), step(90_000, 2)];
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

test('buildCompactionStep: below threshold → pass-through, summarizer never called', async () => {
  let compactCalls = 0;
  const compactor = stubCompactor({
    decision: { kind: 'skip' },
    onCompact: () => {
      compactCalls++;
    },
  });
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(1_000, 2)], msgs(2)),
  );
  assert.equal(result, undefined);
  assert.equal(compactCalls, 0);
});

test('buildCompactionStep: no completed step / absent usage → pass-through', async () => {
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100 },
  });
  const build = buildCompactionStep({ compactor, modelId: 'm' });
  assert.equal(await build(prepInput([], msgs(1))), undefined);
  assert.equal(await build(prepInput([step(undefined, 1)], msgs(1))), undefined);
});

test('buildCompactionStep: nothing older than the kept tail → pass-through', async () => {
  // One step produced all 3 messages; keepLastSteps covers it → older is empty.
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 6, contextLength: 100_000 },
  });
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(90_000, 3)], msgs(3)),
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
  })(prepInput([step(90_000, 2)], msgs(3)));
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
  })(prepInput([step(90_000, 2), step(90_000, 2)], msgs(5)));
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
    prepInput([step(90_000, 2), step(90_000, 2), step(90_000, 2)], msgs(7)),
  );
  const log = events.find((e) => e.msg === 'compaction: compacted context');
  assert.ok(log, 'a compaction event was logged');
  assert.equal(log?.modelId, 'openai/gpt-5');
  assert.equal(log?.liveInputTokens, 90_000);
  assert.equal(log?.contextLength, 100_000);
  assert.equal(log?.keptSteps, 2);
});

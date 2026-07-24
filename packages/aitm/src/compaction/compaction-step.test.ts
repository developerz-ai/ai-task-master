import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { ModelLimitsLookup } from '../openrouter/model-limits.ts';
import {
  buildCompactionStep,
  type CompactorLike,
  pruneOldToolResults,
  truncateOldestToFit,
} from './compaction-step.ts';
import { type CompactionDecision, Compactor } from './compactor.ts';

// A prepareStep `steps` entry. `ai@6` exposes `response.messages` as the CUMULATIVE response list up
// to that step (not a per-step delta), so `cumulativeCount` is the running total — callers pass an
// increasing sequence (e.g. step(2), step(4), step(6)) to mirror the real SDK shape (issue #176).
function step(cumulativeCount: number) {
  return {
    response: {
      messages: Array.from({ length: cumulativeCount }, (_, i) => ({
        role: 'assistant',
        content: `resp-${i}`,
      })),
    },
  };
}

// Like step(), but also carries the provider-reported per-step `usage` the compaction trigger reads
// off the most recent step (StepResult.usage.inputTokens) to ground its size estimate (issue #102).
function stepWithUsage(cumulativeCount: number, inputTokens: number) {
  return { ...step(cumulativeCount), usage: { inputTokens } };
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

// Realistic tool-call / tool-result message pair (content is a parts array, matching the SDK shape
// the prune pass walks — the string-content `msgs` above are deliberately un-prunable).
function toolCallMsg(id: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'bash', input: {} }],
  };
}

function toolResultMsg(id: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: id, toolName: 'bash', output: { type: 'text', value } },
    ],
  };
}

const CLEARED = /rerun the tool if needed/;

// prepareStep input — only the small structural slice the builder reads. The builder's returned
// function accepts the full SDK options object; we pass this partial (unchecked in tests).
function prepInput(steps: unknown[], messages: unknown[]) {
  return { steps, stepNumber: steps.length, model: {}, messages, experimental_context: undefined };
}

function stubCompactor(opts: {
  decision: CompactionDecision;
  summary?: string;
  compactReturnsUndefined?: boolean;
  onCompact?: (older: readonly unknown[], priorSummary?: string) => void;
  shouldThrows?: boolean;
  compactThrows?: boolean;
  // The usable input-token budget the post-compaction fit check verifies against. Defaults large so
  // control-flow tests (whose small message arrays trivially fit) exercise the intended path; the
  // overflow-guarantee tests set it small to force the summarize / hard-truncate escalation.
  usable?: number;
}): CompactorLike {
  return {
    shouldCompact: async () => {
      if (opts.shouldThrows) throw new Error('lookup boom');
      return opts.decision;
    },
    compact: async (older, priorSummary) => {
      opts.onCompact?.(older, priorSummary);
      if (opts.compactThrows) throw new Error('summarizer boom');
      if (opts.compactReturnsUndefined) return undefined;
      return opts.summary ?? 'SUMMARY';
    },
    usableInputTokensFor: async () => opts.usable ?? 1_000_000,
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

test('buildCompactionStep: above threshold → [pinned brief, summary user msg, ...keepLastSteps tail], cut at a step boundary', async () => {
  // 4 steps, cumulative response counts [2, 4, 6, 8] (SDK shape) = 8 step-messages, plus the initial
  // user prompt = 9 total. With the pre-fix code this summed the last 2 arrays (6+8=14 > 9) → splitAt
  // pinned to 0 → pass-through: this test is the regression proof that compaction fires (issue #176).
  const steps = [step(2), step(4), step(6), step(8)];
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
  // keepLastSteps=2 → last 2 steps' delta = cumulative 8 − 4 = 4 messages → tail = last 4;
  // brief(1)+summary(1)+tail(4)=6.
  assert.equal(result.messages.length, 6);
  // The run's first user message is pinned verbatim ahead of the summary.
  assert.deepEqual(result.messages[0], { role: 'user', content: 'goal' });
  // The summary is the SECOND message, not the first.
  assert.equal(result.messages[1].role, 'user');
  assert.match(String(result.messages[1].content), /TIGHT SUMMARY/);
  assert.match(String(result.messages[1].content), /summarized to fit the context window/i);
  // Tail is the last 4 original messages verbatim (step boundary preserved).
  assert.deepEqual(result.messages.slice(2), messages.slice(messages.length - 4));
  // Older (summarized) = the first 5 messages (9 - 4).
  assert.equal(compactedOlder.length, 5);
});

test('buildCompactionStep: pins the run first user message verbatim ahead of the summary (task brief survives)', async () => {
  // The original task brief (messages[0]) lives in `older` and would be folded into the lossy
  // summary. It must survive verbatim, ahead of the summary, so a long run never drifts off its goal.
  const brief = 'ORIGINAL TASK: ship the widget and do not re-plan';
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100_000 },
    summary: 'LOSSY SUMMARY',
  });
  const messages = [{ role: 'user', content: brief }, ...msgs(8)];
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4), step(6), step(8)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  // The brief is pinned first, verbatim (role + content unchanged).
  assert.deepEqual(result.messages[0], { role: 'user', content: brief });
  // The summary is the SECOND message — it never displaces the pinned brief.
  assert.match(String(result.messages[1]?.content), /LOSSY SUMMARY/);
  assert.match(String(result.messages[1]?.content), /summarized to fit the context window/i);
  // The brief stands alone, not merely folded into the summary text.
  assert.notEqual(result.messages[0]?.content, result.messages[1]?.content);
});

test('buildCompactionStep: no user message in the summarized prefix → nothing to pin, summary leads', async () => {
  // A prefix that opens on an assistant turn (no user message in `older`) has no brief to pin — the
  // result is the summary followed by the kept tail, unchanged from the pre-pin behavior.
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    summary: 'NOBRIEF',
  });
  // msgs(n) is all assistant/tool — no user message anywhere.
  const messages = msgs(7);
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4), step(6)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  assert.equal(result.messages[0]?.role, 'user');
  assert.match(String(result.messages[0]?.content), /NOBRIEF/);
});

test('buildCompactionStep: an oversized brief is dropped rather than sent overflowing — summary still fits (overflow guarantee wins)', async () => {
  // A pathologically huge first user message cannot be pinned without blowing the very budget
  // compaction exists to satisfy. The pin is best-effort: the brief is dropped so summary + tail
  // provably fit, never returned overflowing (Decision #20 outranks the pin).
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    summary: 'FITS',
    usable: 1_000,
  });
  const messages: ModelMessage[] = [
    { role: 'user', content: `HUGE_BRIEF${'x'.repeat(60_000)}` },
    toolCallMsg('a'),
    toolResultMsg('a', 'older-a'),
    toolCallMsg('b'),
    toolResultMsg('b', 'small-tail'),
  ];
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  // The huge brief is gone; the summary leads and the kept tail rides along, all within budget.
  assert.doesNotMatch(JSON.stringify(result.messages), /HUGE_BRIEF/);
  assert.match(String(result.messages[0]?.content), /FITS/);
  assert.match(JSON.stringify(result.messages), /small-tail/);
});

test('buildCompactionStep: threads the prior summary into the next compaction (anchored update, not fresh)', async () => {
  // Two compactions in one run (one build closure). The first has no prior summary; the second must
  // receive the first's output as `priorSummary` so Compactor takes the anchored-update path instead
  // of re-summarizing from scratch and letting the note drift each round (PR #232 review). The second
  // call uses a longer `messages` array than the first (a later step, growing history — not a same-
  // length retry) so the messages-length cache doesn't collapse them into one compaction.
  const priorSummaries: Array<string | undefined> = [];
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100_000 },
    summary: 'ANCHOR',
    onCompact: (_older, priorSummary) => {
      priorSummaries.push(priorSummary);
    },
  });
  const build = buildCompactionStep({ compactor, modelId: 'm' });
  // String-content messages are un-prunable → 0 freed → the LLM summarize path runs both times.
  const messages = [{ role: 'user', content: 'goal' }, ...msgs(8)];
  const first = await build(prepInput([step(2), step(4), step(6), step(8)], messages));
  const moreMessages = [...messages, ...msgs(2)];
  const second = await build(
    prepInput([step(2), step(4), step(6), step(8), step(10)], moreMessages),
  );
  assert.ok(first && second);
  assert.deepEqual(priorSummaries, [undefined, 'ANCHOR']);
});

test('buildCompactionStep sizes off the live messages via a real Compactor: large context compacts, small does not (issue #102)', async () => {
  // The override is not persisted across steps by the installed ai, so sizing must read the live
  // `messages` (the real to-be-sent context), not the last step's usage. A tiny window plus a tiny
  // reply reserve (usable = 100 - 20 = 80 tokens) makes the char estimate cross the budget on a
  // large message array and stay under it on a small one.
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
    compactor: new Compactor({ summarizer, limits, keepLastSteps: 1, reserveTokens: 20 }),
    modelId: 'm',
  });

  // Small live context (~1 token) → stays under the 80-token budget → pass-through.
  const small = await build(prepInput([step(1)], [msg('user', 'hi'), msg('assistant', 'ok')]));
  assert.equal(small, undefined);

  // Large live context (~200 tokens vs an 80-token budget) → crosses it → real summarizer runs.
  const big = 'x'.repeat(400);
  const large = await build(
    prepInput([step(1), step(2)], [msg('user', big), msg('assistant', big), msg('tool', 'r')]),
  );
  assert.ok(large && Array.isArray(large.messages));
  assert.match(String(large.messages[0].content), /REAL SUMMARY/);
});

test('buildCompactionStep: feeds shouldCompact the provider-reported last-call tokens + the delta since', async () => {
  let seen: unknown;
  const compactor: CompactorLike = {
    shouldCompact: async (_modelId, live) => {
      seen = live;
      return { kind: 'skip' };
    },
    compact: async () => 'S',
  };
  // Four 4-char messages → whole-array estimate = ceil(16/4) = 4. Steps cumulative [2, 4] → the last
  // step appended 2 messages (delta), so `since` = the last 2 messages = ceil(8/4) = 2. The last step
  // reported 5000 input tokens.
  const messages = [
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: 'aaaa' },
    { role: 'tool', content: 'bbbb' },
    { role: 'assistant', content: 'cccc' },
  ];
  await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), stepWithUsage(4, 5000)], messages),
  );
  assert.deepEqual(seen, {
    estimatedInputTokens: 4,
    reported: { lastCallInputTokens: 5000, sinceTokens: 2 },
  });
});

test('buildCompactionStep: no reported usage on the last step → estimate only (fallback)', async () => {
  let seen: unknown;
  const compactor: CompactorLike = {
    shouldCompact: async (_modelId, live) => {
      seen = live;
      return { kind: 'skip' };
    },
    compact: async () => 'S',
  };
  // step() carries no `usage` → the trigger falls back to the whole-array char estimate, no `reported`.
  await buildCompactionStep({ compactor, modelId: 'm' })(prepInput([step(2), step(4)], msgs(4)));
  assert.ok(seen && typeof seen === 'object' && !('reported' in seen));
});

test('buildCompactionStep: usage-grounded trigger compacts when the char estimate alone stays under (issue #102)', async () => {
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
  const compactorInit = {
    compactor: new Compactor({ summarizer, limits, keepLastSteps: 1, reserveTokens: 20 }),
    modelId: 'm',
  };
  const messages = [
    { role: 'user', content: 'goal' },
    { role: 'assistant', content: 'aaaa' },
    { role: 'tool', content: 'bbbb' },
    { role: 'assistant', content: 'cccc' },
  ];
  // Four short messages estimate ~4 tokens, far under the 80-token budget (a 100 window minus a
  // 20-token reply reserve). But the last step reported 80 input tokens — the system prompt + tool
  // schemas the estimate can't see — so the grounded size reaches the budget and compaction runs.
  const grounded = await buildCompactionStep(compactorInit)(
    prepInput([step(2), stepWithUsage(4, 80)], messages),
  );
  assert.ok(grounded && Array.isArray(grounded.messages));
  assert.match(String(grounded.messages[0].content), /REAL SUMMARY/);

  // Same messages, but the last step reports no usage → estimate-only (~4) stays under → pass-through.
  // A separate build closure: same message-array length as above, but this is an independently sized
  // scenario, not a same-length retry of the call above — the messages-length cache is per-closure.
  const passthrough = await buildCompactionStep(compactorInit)(
    prepInput([step(2), step(4)], messages),
  );
  assert.equal(passthrough, undefined);
});

test('buildCompactionStep: a same-length repeat (within-step retry) reuses the cached result — no second summarizer call', async () => {
  // `ai` calls prepareStep again with an unchanged `messages` array on within-step retries, and —
  // since the override isn't persisted across steps — the step right after a compaction also sees
  // `messages` back at its pre-compaction length. Either way, a repeat call whose message-array
  // length is unchanged from the last call must reuse that result instead of paying a second
  // summarizer round trip.
  let compactCalls = 0;
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100_000 },
    summary: 'ONE SUMMARY',
    onCompact: () => {
      compactCalls++;
    },
  });
  const build = buildCompactionStep({ compactor, modelId: 'm' });
  const steps = [step(2), step(4), step(6), step(8)];
  const messages = [{ role: 'user', content: 'goal' }, ...msgs(8)];

  const first = await build(prepInput(steps, messages));
  const retry = await build(prepInput(steps, messages));

  assert.equal(compactCalls, 1);
  assert.ok(first && retry);
  assert.deepEqual(retry, first);
});

test('buildCompactionStep: cache miss on a grown message array recomputes (not stuck on the first result)', async () => {
  // Guards against an over-eager cache: once the array grows past the cached length, a fresh
  // compaction must run again rather than returning the stale first result forever.
  let compactCalls = 0;
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100_000 },
    summary: 'S',
    onCompact: () => {
      compactCalls++;
    },
  });
  const build = buildCompactionStep({ compactor, modelId: 'm' });
  const messages = [{ role: 'user', content: 'goal' }, ...msgs(8)];
  await build(prepInput([step(2), step(4), step(6), step(8)], messages));
  await build(prepInput([step(2), step(4), step(6), step(8), step(10)], [...messages, ...msgs(2)]));
  assert.equal(compactCalls, 2);
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

test('buildCompactionStep: continuation edge — no completed steps → pass-through, live tail never summarized (issue #176)', async () => {
  // A #107 continuation's first prepareStep sees steps=[] but a full injected history in `messages`.
  // Sizing off cumulative deltas with steps=[] would make the whole history `older` and drop the live
  // tail; the guard passes through instead. Threshold says compact, so only the guard prevents it.
  let compactCalls = 0;
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 2, contextLength: 100_000 },
    onCompact: () => {
      compactCalls++;
    },
  });
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(prepInput([], msgs(10)));
  assert.equal(result, undefined);
  assert.equal(compactCalls, 0, 'summarizer never runs on the first continuation step');
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

test('buildCompactionStep: summarizer failure but context already fits → pass-through + warning (non-fatal)', async () => {
  const events: Array<Record<string, unknown>> = [];
  const messages = msgs(5);
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    compactThrows: true,
  });
  const result = await buildCompactionStep({
    compactor,
    modelId: 'm',
    logger: captureLogger(events),
  })(prepInput([step(2), step(4)], messages));
  // The pruned context fits, so a summarizer failure passes it through with no context dropped.
  assert.ok(result && Array.isArray(result.messages));
  assert.equal(result.messages.length, messages.length);
  assert.ok(events.some((e) => e.level === 'warn' && /summarizer failed/i.test(String(e.msg))));
});

test('buildCompactionStep: empty/whitespace summary but context already fits → pass-through + warning, no context dropped', async () => {
  const events: Array<Record<string, unknown>> = [];
  const messages = msgs(5);
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    compactReturnsUndefined: true,
  });
  const result = await buildCompactionStep({
    compactor,
    modelId: 'm',
    logger: captureLogger(events),
  })(prepInput([step(2), step(4)], messages));
  assert.ok(result && Array.isArray(result.messages));
  assert.equal(result.messages.length, messages.length);
  assert.ok(
    events.some((e) => e.level === 'warn' && /summarizer returned empty text/i.test(String(e.msg))),
  );
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

// 7 messages, steps cumulative [2,4,6] with keepLastSteps=1 → tail = last 2 (indices 5,6), so the
// two big older results (indices 2 and 4) are prunable. Walking newest→oldest: index 4 fills the 40k
// shield and is kept; index 2 is beyond the shield and gets cleared. Shared layout for the tests
// below.
function bigToolConversation(tailResult: string): ModelMessage[] {
  return [
    { role: 'user', content: 'goal' },
    toolCallMsg('a'),
    toolResultMsg('a', `AAA_OLD${'x'.repeat(50_000)}`),
    toolCallMsg('b'),
    toolResultMsg('b', `BBB_SHIELD${'x'.repeat(50_000)}`),
    toolCallMsg('c'),
    toolResultMsg('c', tailResult),
  ];
}

test('buildCompactionStep: prune clears old large tool results, respects the 40k recency shield, and skips the summarizer when ≥20k freed', async () => {
  let compactCalls = 0;
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    onCompact: () => {
      compactCalls++;
    },
  });
  const messages = bigToolConversation('CCC_TAIL small');
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4), step(6)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  // Full history returned (same length), not a summary replacement.
  assert.equal(result.messages.length, 7);
  // Oldest big result (index 2) is beyond the shield → payload cleared, original content gone.
  assert.match(JSON.stringify(result.messages[2]), CLEARED);
  assert.doesNotMatch(JSON.stringify(result.messages[2]), /AAA_OLD/);
  // Most-recent older result (index 4) sits inside the 40k shield → kept verbatim.
  assert.match(JSON.stringify(result.messages[4]), /BBB_SHIELD/);
  assert.doesNotMatch(JSON.stringify(result.messages[4]), CLEARED);
  // Pruning alone freed ≥20k → the LLM summarizer never ran.
  assert.equal(compactCalls, 0);
});

test('buildCompactionStep: the kept-steps tail is never pruned, even when large', async () => {
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
  });
  // Tail result (index 6) is huge and the shield is already full from older output — still verbatim.
  const messages = bigToolConversation(`CCC_TAIL${'x'.repeat(50_000)}`);
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4), step(6)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  assert.match(JSON.stringify(result.messages[6]), /CCC_TAIL/);
  assert.doesNotMatch(JSON.stringify(result.messages[6]), CLEARED);
  // Older result still cleared — the tail exemption is positional, not size-based.
  assert.match(JSON.stringify(result.messages[2]), CLEARED);
});

test('buildCompactionStep: tool results ≤1k are never cleared → nothing freed → summarizer still runs', async () => {
  let compactedOlder: readonly unknown[] = [];
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    summary: 'SUMOUT',
    onCompact: (older) => {
      compactedOlder = older;
    },
  });
  const messages: ModelMessage[] = [
    { role: 'user', content: 'goal' },
    toolCallMsg('a'),
    toolResultMsg('a', `small-a${'x'.repeat(500)}`),
    toolCallMsg('b'),
    toolResultMsg('b', 'small-b'),
    toolCallMsg('c'),
    toolResultMsg('c', 'small-c'),
  ];
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4), step(6)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  // Nothing was large enough to clear → falls through to the LLM summarize path (summary message),
  // with the run's first user message pinned verbatim ahead of it.
  assert.deepEqual(result.messages[0], { role: 'user', content: 'goal' });
  assert.match(String(result.messages[1]?.content), /SUMOUT/);
  assert.ok(compactedOlder.length > 0);
  assert.doesNotMatch(JSON.stringify(compactedOlder), CLEARED);
});

test('buildCompactionStep: <20k freed → summarizes the pruned older prefix (cleared payload carried in)', async () => {
  let compactedOlder: readonly unknown[] = [];
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    summary: 'SUMOUT',
    onCompact: (older) => {
      compactedOlder = older;
    },
  });
  // index 4 (42k) fills the 40k shield; index 2 (12k) is cleared → ~12k freed, under the 20k skip cut.
  const messages: ModelMessage[] = [
    { role: 'user', content: 'goal' },
    toolCallMsg('a'),
    toolResultMsg('a', `AAA_OLD${'x'.repeat(12_000)}`),
    toolCallMsg('b'),
    toolResultMsg('b', `BBB_SHIELD${'x'.repeat(42_000)}`),
    toolCallMsg('c'),
    toolResultMsg('c', 'small-c'),
  ];
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4), step(6)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  // Brief pinned first, summary second.
  assert.deepEqual(result.messages[0], { role: 'user', content: 'goal' });
  assert.match(String(result.messages[1]?.content), /SUMOUT/);
  // The summarizer received the pruned older prefix: the cleared placeholder is present, AAA_OLD gone.
  assert.match(JSON.stringify(compactedOlder), CLEARED);
  assert.doesNotMatch(JSON.stringify(compactedOlder), /AAA_OLD/);
});

test('buildCompactionStep: prune frees ≥20k but is still over budget → falls through to summarize, never returned overflowing (finding 08 HIGH)', async () => {
  // The bug: freeing ≥20k chars returned immediately without checking the result fits. Here the prune
  // clears a 60k older result (freed ≫ 20k) but a 50k shielded result stays, so the pruned context is
  // still ~12.5k tokens against a 5k budget. It must NOT be returned — it must summarize.
  let compactCalls = 0;
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    summary: 'SUMOUT',
    usable: 5_000,
    onCompact: () => {
      compactCalls++;
    },
  });
  const messages: ModelMessage[] = [
    { role: 'user', content: 'goal' },
    toolCallMsg('a'),
    toolResultMsg('a', `AAA_OLD${'x'.repeat(60_000)}`),
    toolCallMsg('b'),
    toolResultMsg('b', `BBB_SHIELD${'x'.repeat(50_000)}`),
    toolCallMsg('c'),
    toolResultMsg('c', 'small-c'),
  ];
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4), step(6)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  assert.equal(compactCalls, 1, 'the prune fast-path did NOT short-circuit — summarize ran');
  // Brief + summary + kept tail, not the still-overflowing pruned array; older summarized away.
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.messages[0], { role: 'user', content: 'goal' });
  assert.match(String(result.messages[1]?.content), /SUMOUT/);
  assert.doesNotMatch(JSON.stringify(result.messages), /BBB_SHIELD|AAA_OLD/);
});

test('buildCompactionStep: summary still over budget → hard-truncates the tail, brief + summary pinned first', async () => {
  // A single huge verbatim tool result in the kept tail keeps brief+summary+tail over budget; the
  // escalation drops the oldest tail messages (the huge result and its tool-call together) until it
  // provably fits, keeping the brief + summary pinned first.
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    summary: 'SUMOUT2',
    usable: 1_000,
  });
  const messages: ModelMessage[] = [
    { role: 'user', content: 'goal' },
    toolCallMsg('a'),
    toolResultMsg('a', 'older-a'),
    toolCallMsg('b'),
    toolResultMsg('b', `BIG_TAIL${'x'.repeat(50_000)}`),
  ];
  const result = await buildCompactionStep({ compactor, modelId: 'm' })(
    prepInput([step(2), step(4)], messages),
  );
  assert.ok(result && Array.isArray(result.messages));
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0], { role: 'user', content: 'goal' });
  assert.match(String(result.messages[1]?.content), /SUMOUT2/);
  assert.doesNotMatch(JSON.stringify(result.messages), /BIG_TAIL/);
});

test('buildCompactionStep: no usable summary + over budget → hard-truncates the pruned history to fit + warns', async () => {
  const events: Array<Record<string, unknown>> = [];
  const compactor = stubCompactor({
    decision: { kind: 'compact', keepLastSteps: 1, contextLength: 100_000 },
    compactThrows: true,
    usable: 100,
  });
  const messages: ModelMessage[] = [
    { role: 'user', content: 'goal' },
    toolCallMsg('a'),
    toolResultMsg('a', `AAA${'x'.repeat(50_000)}`),
    toolCallMsg('b'),
    toolResultMsg('b', `BBB${'x'.repeat(50_000)}`),
    toolCallMsg('c'),
    toolResultMsg('c', 'small-c'),
  ];
  const result = await buildCompactionStep({
    compactor,
    modelId: 'm',
    logger: captureLogger(events),
  })(prepInput([step(2), step(4), step(6)], messages));
  assert.ok(result && Array.isArray(result.messages));
  // Dropped down to the newest step (its tool-call + result), never the still-overflowing full array.
  assert.equal(result.messages.length, 2);
  assert.equal(
    result.messages[0]?.role,
    'assistant',
    'newest step kept its tool-call, not orphaned',
  );
  assert.doesNotMatch(JSON.stringify(result.messages), /BBB|AAA/);
  assert.ok(
    events.some(
      (e) =>
        e.level === 'warn' &&
        /over budget/i.test(String(e.msg)) &&
        /hard-truncated/i.test(String(e.msg)),
    ),
  );
});

test('truncateOldestToFit: keeps the largest fitting suffix, dropping the oldest messages', () => {
  const messages = [
    msg('user', 'a'),
    msg('assistant', 'b'),
    msg('user', 'c'),
    msg('assistant', 'd'),
  ];
  const out = truncateOldestToFit(messages, (c) => c.length <= 2);
  assert.deepEqual(out, messages.slice(2));
});

test('truncateOldestToFit: never orphans a tool-result — cuts before the assistant tool-call', () => {
  const messages: ModelMessage[] = [
    toolCallMsg('a'),
    toolResultMsg('a', 'ra'),
    toolCallMsg('b'),
    toolResultMsg('b', 'rb'),
  ];
  // An impossible budget (nothing fits): still returns the smallest STRUCTURALLY VALID candidate,
  // which starts on the assistant tool-call, never a bare tool-result.
  const out = truncateOldestToFit(messages, () => false);
  assert.deepEqual(out, [toolCallMsg('b'), toolResultMsg('b', 'rb')]);
  assert.equal(out[0]?.role, 'assistant');
});

test('truncateOldestToFit: protects the leading prefix and can drop the whole body down to it', () => {
  const summary = msg('user', 'SUMMARY');
  const messages: ModelMessage[] = [summary, toolCallMsg('a'), toolResultMsg('a', 'ra')];
  const out = truncateOldestToFit(messages, (c) => c.length <= 1, 1);
  assert.deepEqual(out, [summary]);
});

test('truncateOldestToFit: never returns empty and never mutates its input', () => {
  const messages = [msg('user', 'a'), msg('assistant', 'b')];
  const before = messages.map((m) => JSON.stringify(m));
  const out = truncateOldestToFit(messages, () => false);
  assert.ok(out.length >= 1);
  assert.deepEqual(
    messages.map((m) => JSON.stringify(m)),
    before,
  );
});

test('pruneOldToolResults: clears shield-exceeding results, keeps recent + tail, never mutates input', () => {
  const messages: ModelMessage[] = [
    toolResultMsg('r0', `CLEARME${'x'.repeat(200)}`), // 0: older, beyond shield → cleared
    toolResultMsg('r1', `KEEPME${'x'.repeat(200)}`), // 1: older, within shield → kept
    toolResultMsg('r2', `TAILME${'x'.repeat(200)}`), // 2: at/after splitAt → never walked
  ];
  const before = messages.map((m) => JSON.stringify(m));
  const {
    messages: out,
    freedChars,
    clearedResults,
  } = pruneOldToolResults(messages, 2, {
    shieldChars: 150, // the recent result (~206 chars) alone fills the shield
    minResultChars: 50, // both older results exceed this → prunable-eligible
  });
  assert.match(JSON.stringify(out[1]), /KEEPME/); // shield protected the most recent
  assert.match(JSON.stringify(out[0]), CLEARED); // oldest cleared
  assert.doesNotMatch(JSON.stringify(out[0]), /CLEARME/); // original payload gone
  assert.match(JSON.stringify(out[2]), /TAILME/); // tail region untouched
  assert.equal(clearedResults, 1);
  assert.ok(freedChars > 0);
  // Input array is untouched (fresh objects only for changed entries).
  assert.deepEqual(
    messages.map((m) => JSON.stringify(m)),
    before,
  );
});

test('pruneOldToolResults: no prunable region (splitAt 0) → returns input copy, frees nothing', () => {
  const messages: ModelMessage[] = [toolResultMsg('a', `A${'x'.repeat(50_000)}`)];
  const { messages: out, freedChars, clearedResults } = pruneOldToolResults(messages, 0);
  assert.equal(freedChars, 0);
  assert.equal(clearedResults, 0);
  assert.match(JSON.stringify(out[0]), /A/);
  assert.doesNotMatch(JSON.stringify(out[0]), CLEARED);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RetryInfo } from '@developerz.ai/ai-claude-compat';
import type { AssistantModelMessage, ToolSet } from 'ai';
import { labelText } from '../observability/step-progress.ts';
import type { TranscriptRecorder } from '../state/transcript-store.ts';
import { stepResponse, stepResult } from '../testing/step-results.ts';
import {
  buildSubagentSession,
  onRetryProgress,
  recordStepDeltas,
  retryProgressMessage,
} from './subagent-session.ts';

function withCapturedStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = real;
  }
  return lines;
}

// The handler slices the cumulative list by COUNT, so these only have to be distinguishable — but
// they still have to be messages, which is what the old `['a', 'b'] as never` opted out of saying.
function messages(...texts: string[]): AssistantModelMessage[] {
  return texts.map((text) => ({ role: 'assistant', content: text }));
}

// A minimal TranscriptRecorder double: only `step` is exercised by recordStepDeltas/buildSubagentSession.
function stubRecorder(): { recorder: TranscriptRecorder; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const recorder = {
    step: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as TranscriptRecorder;
  return { recorder, calls };
}

test('retryProgressMessage: renders reason, delay in seconds, and attempt count', () => {
  const info: RetryInfo = { reason: 'rate limited', delayMs: 2400, attempt: 2, maxAttempts: 5 };
  assert.equal(retryProgressMessage(info), 'Rate limited (rate limited), retrying in 2s (2/5)');
});

test('retryProgressMessage: clamps a negative delay to 0s', () => {
  const info: RetryInfo = { reason: 'x', delayMs: -100, attempt: 1, maxAttempts: 3 };
  assert.equal(retryProgressMessage(info), 'Rate limited (x), retrying in 0s (1/3)');
});

test('onRetryProgress: writes the retry line through the given sink', () => {
  const lines: string[] = [];
  const sink = {
    write: (line: string) => lines.push(line),
    color: false,
    now: () => new Date(2026, 0, 1),
    lastEmitMs: () => 0,
  };
  const onRetry = onRetryProgress(undefined, sink);
  onRetry({ reason: 'timeout', delayMs: 1000, attempt: 1, maxAttempts: 2 });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /Rate limited \(timeout\), retrying in 1s \(1\/2\)/);
});

test('recordStepDeltas: records only the per-step delta across cumulative response.messages', async () => {
  const { recorder, calls } = stubRecorder();
  const handler = recordStepDeltas(recorder);
  handler({ response: { messages: messages('a', 'b') } });
  handler({ response: { messages: messages('a', 'b', 'c', 'd') } });
  // Give the fire-and-forget `void recorder.step(...)` calls a tick to land.
  await Promise.resolve();
  assert.deepEqual(
    calls.map((c) => c[0]),
    [messages('a', 'b'), messages('c', 'd')],
  );
});

test('recordStepDeltas: an empty delta (identical length) records nothing', async () => {
  const { recorder, calls } = stubRecorder();
  const handler = recordStepDeltas(recorder);
  handler({ response: { messages: messages('a') } });
  handler({ response: { messages: messages('a') } });
  await Promise.resolve();
  assert.equal(calls.length, 1);
});

test('buildSubagentSession: composes the tag from phase + counter', () => {
  const session = buildSubagentSession<ToolSet>({
    role: 'worker',
    model: 'k3',
    ctx: 'g1',
    phase: 'working',
    counter: { unit: 'task', index: 3, total: 38 },
    streaming: false,
  });
  assert.deepEqual(session.tag, { phase: 'working', unit: 'task', index: 3, total: 38 });
});

test('buildSubagentSession: omitting counter leaves a phase-only tag', () => {
  const session = buildSubagentSession<ToolSet>({
    role: 'planner',
    model: 'k3',
    phase: 'planning',
    streaming: false,
  });
  assert.deepEqual(session.tag, { phase: 'planning' });
});

test('buildSubagentSession: the label carries model, role and ctx — no specialist/file when omitted', () => {
  const session = buildSubagentSession<ToolSet>({
    role: 'worker',
    model: 'k3',
    ctx: 'g1',
    phase: 'working',
    streaming: false,
  });
  assert.equal(labelText(session.label), 'k3 worker g1');
});

test('buildSubagentSession: a routed specialist name replaces the bare role in the label', () => {
  const session = buildSubagentSession<ToolSet>({
    role: 'worker',
    model: 'k3',
    ctx: 'g1',
    specialist: 'backend',
    phase: 'working',
    streaming: false,
  });
  assert.equal(labelText(session.label), 'k3 backend g1');
});

test('buildSubagentSession: streaming true yields an onStream renderer; false omits it', () => {
  const streamed = buildSubagentSession<ToolSet>({
    role: 'worker',
    model: 'k3',
    phase: 'working',
    streaming: true,
  });
  const notStreamed = buildSubagentSession<ToolSet>({
    role: 'worker',
    model: 'k3',
    phase: 'working',
    streaming: false,
  });
  assert.equal(typeof streamed.onStream, 'function');
  assert.equal(notStreamed.onStream, undefined);
});

test('buildSubagentSession: onStepFinish folds the recorder delta in alongside the progress line', async () => {
  const { recorder, calls } = stubRecorder();
  const session = buildSubagentSession<ToolSet>({
    role: 'worker',
    model: 'k3',
    phase: 'working',
    streaming: false,
    recorder,
  });
  withCapturedStderr(() => {
    session.onStepFinish(stepResult({ response: stepResponse(messages('a', 'b')) }));
  });
  await Promise.resolve();
  assert.deepEqual(
    calls.map((c) => c[0]),
    [messages('a', 'b')],
  );
});

test('buildSubagentSession: no recorder → onStepFinish is still callable (progress-only)', () => {
  const session = buildSubagentSession<ToolSet>({
    role: 'worker',
    model: 'k3',
    phase: 'working',
    streaming: false,
  });
  const lines = withCapturedStderr(() => {
    session.onStepFinish(stepResult({ text: 'hi' }));
  });
  assert.ok(lines.length > 0, 'still renders the progress line with no recorder');
});

test('buildSubagentSession: onRetry writes a retry line under the session tag', () => {
  const session = buildSubagentSession<ToolSet>({
    role: 'ci-fix',
    model: 'k3',
    ctx: 'g1',
    phase: 'ci-fix',
    streaming: false,
  });
  const lines = withCapturedStderr(() => {
    session.onRetry({ reason: 'overload', delayMs: 3000, attempt: 1, maxAttempts: 3 });
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /Rate limited \(overload\), retrying in 3s \(1\/3\)/);
});

test('buildSubagentSession: start() returns an idempotent stop function', () => {
  const session = buildSubagentSession<ToolSet>({
    role: 'worker',
    model: 'k3',
    phase: 'working',
    streaming: false,
  });
  const stop = session.start();
  assert.equal(typeof stop, 'function');
  assert.doesNotThrow(() => {
    stop();
    stop();
  });
});

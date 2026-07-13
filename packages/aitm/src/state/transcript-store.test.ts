import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ModelMessage } from 'ai';
import { reconstructTranscript, TranscriptStore } from './transcript-store.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aitm-transcript-'));
}

const msg = (role: 'user' | 'assistant', text: string): ModelMessage => ({ role, content: text });

// --- reconstructTranscript (pure) ---

test('reconstructTranscript concatenates step messages and flags completion on run-end', () => {
  const raw = [
    JSON.stringify({ kind: 'step', ts: 't1', messages: [msg('assistant', 'a')] }),
    JSON.stringify({ kind: 'step', ts: 't2', messages: [msg('user', 'b'), msg('assistant', 'c')] }),
  ].join('\n');
  const open = reconstructTranscript(raw);
  assert.deepEqual(open.messages, [msg('assistant', 'a'), msg('user', 'b'), msg('assistant', 'c')]);
  assert.equal(open.complete, false, 'no run-end → interrupted');

  const closed = reconstructTranscript(
    `${raw}\n${JSON.stringify({ kind: 'run-end', ts: 't3', outcome: 'submitted' })}`,
  );
  assert.equal(closed.complete, true, 'run-end → complete');
});

test('reconstructTranscript: a compaction record replaces the accumulated array; later steps append', () => {
  const raw = [
    JSON.stringify({ kind: 'step', ts: 't1', messages: [msg('assistant', 'old-1')] }),
    JSON.stringify({ kind: 'step', ts: 't2', messages: [msg('assistant', 'old-2')] }),
    JSON.stringify({ kind: 'compaction', ts: 't3', messages: [msg('user', 'SUMMARY')] }),
    JSON.stringify({ kind: 'step', ts: 't4', messages: [msg('assistant', 'new')] }),
  ].join('\n');
  assert.deepEqual(reconstructTranscript(raw).messages, [
    msg('user', 'SUMMARY'),
    msg('assistant', 'new'),
  ]);
});

test('reconstructTranscript: a corrupt/truncated line is skipped with a warning; the rest replays', () => {
  const warns: string[] = [];
  const raw = [
    JSON.stringify({ kind: 'step', ts: 't1', messages: [msg('assistant', 'a')] }),
    '{"kind":"step","messages":[{"role":"assist', // truncated mid-append (crash)
  ].join('\n');
  const out = reconstructTranscript(raw, (m) => warns.push(m));
  assert.deepEqual(out.messages, [msg('assistant', 'a')], 'preceding record survived');
  assert.equal(warns.length, 1, 'corrupt line warned');
});

test('reconstructTranscript skips unknown kinds (forward compatible)', () => {
  const raw = [
    JSON.stringify({ kind: 'future-kind', ts: 't1', data: 1 }),
    JSON.stringify({ kind: 'step', ts: 't2', messages: [msg('assistant', 'a')] }),
  ].join('\n');
  assert.deepEqual(reconstructTranscript(raw).messages, [msg('assistant', 'a')]);
});

// --- TranscriptStore (fs) ---

test('append/replay round-trip: a recorded run reconstructs to the message array the agent last held', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const rec = await store.begin({ group: 'core', stage: 'working' });
    await rec.step([msg('user', 'goal')], { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
    await rec.step([msg('assistant', 'manifest')]);
    const resumable = await store.findResumable('core', 'working');
    assert.deepEqual(resumable?.messages, [msg('user', 'goal'), msg('assistant', 'manifest')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findResumable: a run-end-terminated transcript is not offered; an interrupted one is', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const done = await store.begin({ group: 'g', stage: 'working' });
    await done.step([msg('assistant', 'x')]);
    await done.end('submitted');
    assert.equal(await store.findResumable('g', 'working'), null, 'completed → not resumable');

    // A newer, interrupted conversation for the same (group, stage) is the one offered.
    const interrupted = await store.begin({ group: 'g', stage: 'working' });
    await interrupted.step([msg('assistant', 'y')]);
    assert.deepEqual((await store.findResumable('g', 'working'))?.messages, [
      msg('assistant', 'y'),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('begin allocates a fresh 1-based ordinal per (group, stage); findResumable prefers the newest', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const first = await store.begin({ group: 'g', stage: 'ci-failed' });
    await first.step([msg('assistant', '1')]);
    const second = await store.begin({ group: 'g', stage: 'ci-failed' });
    await second.step([msg('assistant', '2')]);
    // Two distinct files exist; the newest (ordinal 2) is the resumable one.
    assert.deepEqual((await store.findResumable('g', 'ci-failed'))?.messages, [
      msg('assistant', '2'),
    ]);
    assert.ok(await readFile(join(dir, 'transcripts', 'g', 'ci-failed-1.jsonl'), 'utf8'));
    assert.ok(await readFile(join(dir, 'transcripts', 'g', 'ci-failed-2.jsonl'), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('records redact key/token/secret/authorization fields before serialization', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const rec = await store.begin({ group: 'g', stage: 'working' });
    await rec.step([
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { authorization: 'Bearer sk-secret' } as unknown as ModelMessage,
    ]);
    const raw = await readFile(join(dir, 'transcripts', 'g', 'working-1.jsonl'), 'utf8');
    assert.match(raw, /\[REDACTED\]/);
    assert.ok(!raw.includes('sk-secret'), 'secret value not persisted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findResumable returns null for a group/stage with no transcripts (missing dir, no throw)', async () => {
  const dir = await tmp();
  try {
    assert.equal(await new TranscriptStore(dir).findResumable('nope', 'working'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('planner transcripts are recorded under planner/ (sanity: begin + reconstruct)', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const rec = await store.begin({ planner: true });
    await rec.step([msg('user', 'plan this')]);
    await rec.end('submitted');
    const raw = await readFile(join(dir, 'transcripts', 'planner', 'planner-1.jsonl'), 'utf8');
    assert.equal(reconstructTranscript(raw).complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ModelMessage } from 'ai';
import { modelUsage } from '../testing/model-fixtures.ts';
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

test('reconstructTranscript: a step message failing the ModelMessage shape is skipped; valid siblings and later records survive', () => {
  const warns: string[] = [];
  const raw = [
    // A JSON-valid line whose second message is mistyped (numeric content, not a string/parts).
    JSON.stringify({
      kind: 'step',
      ts: 't1',
      messages: [msg('assistant', 'a'), { role: 'user', content: 5 }],
    }),
    JSON.stringify({ kind: 'step', ts: 't2', messages: [msg('user', 'b')] }),
  ].join('\n');
  const out = reconstructTranscript(raw, (m) => warns.push(m));
  assert.deepEqual(
    out.messages,
    [msg('assistant', 'a'), msg('user', 'b')],
    'the mistyped message is dropped; its valid sibling and the later record are kept',
  );
  assert.equal(warns.length, 1, 'exactly the mistyped message warned');
});

test('reconstructTranscript: N invalid messages across records aggregate into one warning', () => {
  const warns: string[] = [];
  const raw = [
    JSON.stringify({
      kind: 'step',
      ts: 't1',
      messages: [msg('assistant', 'a'), { role: 'user', content: 5 }, { role: 'nope', content: 1 }],
    }),
    JSON.stringify({
      kind: 'compaction',
      ts: 't2',
      messages: [{ role: 'nope', content: 'x' }, msg('user', 'SUMMARY')],
    }),
  ].join('\n');
  const out = reconstructTranscript(raw, (m) => warns.push(m));
  assert.deepEqual(out.messages, [msg('user', 'SUMMARY')]);
  assert.equal(warns.length, 1, 'one aggregated warning for all 3 skips');
  assert.match(warns[0] ?? '', /^skipped 3 invalid transcript messages \(fields: .+\)$/);
});

test('reconstructTranscript: a mistyped message inside a compaction record is skipped, valid ones kept', () => {
  const warns: string[] = [];
  const raw = [
    JSON.stringify({ kind: 'step', ts: 't1', messages: [msg('assistant', 'old')] }),
    JSON.stringify({
      kind: 'compaction',
      ts: 't2',
      messages: [{ role: 'nope', content: 'x' }, msg('user', 'SUMMARY')],
    }),
  ].join('\n');
  const out = reconstructTranscript(raw, (m) => warns.push(m));
  assert.deepEqual(
    out.messages,
    [msg('user', 'SUMMARY')],
    'compaction keeps only the valid message',
  );
  assert.equal(warns.length, 1, 'the invalid-role message warned');
});

test('reconstructTranscript: de-overlaps a pre-#175 cumulative transcript (no duplicated context)', () => {
  // Files written before #175 stored step.messages as the CUMULATIVE response list: each record
  // re-includes everything so far ([a,b], then [a,b,c,d]). Naive concatenation duplicated the prefix.
  const a = msg('user', 'goal');
  const b = msg('assistant', 'a1');
  const c = msg('user', 'r1');
  const d = msg('assistant', 'a2');
  const raw = [
    JSON.stringify({ kind: 'step', ts: 't1', messages: [a, b] }),
    JSON.stringify({ kind: 'step', ts: 't2', messages: [a, b, c, d] }),
    JSON.stringify({ kind: 'run-end', ts: 't3', outcome: 'submitted' }),
  ].join('\n');
  const { messages, complete } = reconstructTranscript(raw);
  assert.deepEqual(messages, [a, b, c, d], 'the overlapping prefix is dropped — 4 messages, not 6');
  assert.equal(complete, true);
});

// --- TranscriptStore (fs) ---

test('append/replay round-trip: a recorded run reconstructs to the message array the agent last held', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const rec = await store.begin({ group: 'core', stage: 'working' });
    await rec.step(
      [msg('user', 'goal')],
      modelUsage({ inputTokens: 5, outputTokens: 3, totalTokens: 8 }),
    );
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

test('concurrent begin() for the same target gets distinct ordinals — no shared file', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const N = 10;
    // Race N begins for one (group, stage). Without a race-free reservation they'd all readdir an
    // empty dir, pick ordinal 1, and interleave into working-1.jsonl.
    const recs = await Promise.all(
      Array.from({ length: N }, () => store.begin({ group: 'g', stage: 'working' })),
    );
    await Promise.all(recs.map((rec, i) => rec.step([msg('assistant', `r${i}`)])));

    const filesDir = join(dir, 'transcripts', 'g');
    const files = (await readdir(filesDir)).filter((f) => /^working-\d+\.jsonl$/.test(f));
    assert.equal(files.length, N, 'one distinct file per concurrent begin');

    // Each file holds exactly one begin's marker (no interleave), and all N markers survived.
    const seen = new Set<string>();
    for (const f of files) {
      const { messages } = reconstructTranscript(await readFile(join(filesDir, f), 'utf8'));
      assert.equal(messages.length, 1, `${f} holds exactly one begin's records`);
      const only = messages[0];
      assert.ok(only);
      seen.add(JSON.stringify(only));
    }
    assert.equal(seen.size, N, 'all N distinct markers present, none lost to a collision');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findResumable skips an empty reserved transcript and returns the earlier resumable one', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const first = await store.begin({ group: 'g', stage: 'working' }); // ordinal 1
    await first.step([msg('assistant', 'real')]); // interrupted, has content
    await store.begin({ group: 'g', stage: 'working' }); // ordinal 2 reserved, never written

    // The empty higher-ordinal reservation must not shadow the resumable ordinal-1 transcript.
    assert.deepEqual((await store.findResumable('g', 'working'))?.messages, [
      msg('assistant', 'real'),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findResumable: a newer COMPLETE transcript over an older interrupted one returns null (no stale resume)', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    // Ordinal 1: a run crashed mid-task — interrupted, has content, no run-end.
    const crashed = await store.begin({ group: 'g', stage: 'working' });
    await crashed.step([msg('assistant', 'crashed task 1')]);
    // Ordinal 2: the resumed run finished (run-end lands here). The next task must NOT be handed
    // the older crashed conversation just because ordinal 1 is still interrupted.
    const resumed = await store.begin({ group: 'g', stage: 'working' });
    await resumed.step([msg('assistant', 'finished task 1')]);
    await resumed.end('submitted');

    assert.equal(
      await store.findResumable('g', 'working'),
      null,
      'newest transcript is complete → nothing to resume; the older crashed one must not surface',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('records redact key/token/secret/authorization fields before serialization', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    const rec = await store.begin({ group: 'g', stage: 'working' });
    // A real assistant tool-call whose input nests an `authorization` field — a valid ModelMessage,
    // so no `as unknown as` (banned by CLAUDE.md); redact recurses into the input and masks it.
    await rec.step([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c',
            toolName: 'fetch',
            input: { authorization: 'Bearer sk-secret' },
          },
        ],
      },
    ]);
    const raw = await readFile(join(dir, 'transcripts', 'g', 'working-1.jsonl'), 'utf8');
    assert.match(raw, /\[REDACTED\]/);
    assert.ok(!raw.includes('sk-secret'), 'secret value not persisted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a transcript write that fails to serialize warns and resolves — never rejects into the agent loop (issue #108 CR)', async () => {
  const dir = await tmp();
  const warns: string[] = [];
  try {
    const store = new TranscriptStore(dir, (m) => warns.push(m));
    const rec = await store.begin({ group: 'g', stage: 'working' });
    // A BigInt makes JSON.stringify throw; append() must catch it, warn, and resolve — not reject.
    await rec.step([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c', toolName: 't', input: { big: 1n } }],
      },
    ]);
    assert.ok(
      warns.some((w) => /transcript write failed/.test(w)),
      'the serialize failure warned instead of throwing',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a recorder that hits 3 consecutive append failures sets a persistent failure marker; findResumable surfaces it', async () => {
  if (process.platform === 'win32') return; // chmod-based perms don't apply on Windows
  if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root bypasses perms
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir, () => {});
    const rec = await store.begin({ group: 'g', stage: 'working' });
    await rec.step([msg('assistant', 'ok')]); // succeeds — transcript has real content
    const file = join(dir, 'transcripts', 'g', 'working-1.jsonl');
    await chmod(file, 0o000); // every further append now fails to open
    await rec.step([msg('assistant', 'fail-1')]);
    await rec.step([msg('assistant', 'fail-2')]);
    await rec.step([msg('assistant', 'fail-3')]); // 3rd consecutive failure — marker should land
    await chmod(file, 0o600); // restore so findResumable can read it back

    assert.equal(
      await access(`${file}.recording-failed`).then(
        () => true,
        () => false,
      ),
      true,
      'marker file written after the 3rd consecutive failure',
    );
    const resumable = await store.findResumable('g', 'working');
    assert.deepEqual(
      resumable?.messages,
      [msg('assistant', 'ok')],
      'content before the failures survived',
    );
    assert.equal(
      resumable?.recordingFailed,
      true,
      'findResumable distinguishes a dead recording from a plain crash-truncated one',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fewer than 3 consecutive append failures do not set the persistent failure marker', async () => {
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir, () => {});
    const rec = await store.begin({ group: 'g', stage: 'working' });
    await rec.step([msg('assistant', 'ok')]);
    const file = join(dir, 'transcripts', 'g', 'working-1.jsonl');
    await chmod(file, 0o000);
    await rec.step([msg('assistant', 'fail-1')]);
    await rec.step([msg('assistant', 'fail-2')]); // only 2 — below threshold
    await chmod(file, 0o600);

    assert.equal(
      await access(`${file}.recording-failed`).then(
        () => true,
        () => false,
      ),
      false,
      'no marker below the consecutive-failure threshold',
    );
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

test('begin prunes an empty ordinal left by a crashed prior process, reusing its ordinal', async () => {
  const dir = await tmp();
  try {
    const first = new TranscriptStore(dir);
    const rec = await first.begin({ group: 'g', stage: 'working' }); // ordinal 1, reserved
    await rec.step([msg('assistant', 'a')]); // real content — never pruned
    await first.begin({ group: 'g', stage: 'working' }); // ordinal 2, reserved, never written — simulates a crash right after begin()

    const filesDir = join(dir, 'transcripts', 'g');
    assert.deepEqual(
      (await readdir(filesDir)).sort(),
      ['working-1.jsonl', 'working-2.jsonl'],
      'both ordinals exist before the next process starts',
    );

    // A fresh TranscriptStore (new process) has no record of ordinal 2 being "in flight" — its first
    // begin() must see it as an empty leftover and prune it before reserving the next ordinal.
    const second = new TranscriptStore(dir);
    const reused = await second.begin({ group: 'g', stage: 'working' });
    await reused.step([msg('assistant', 'b')]);

    assert.deepEqual(
      (await readdir(filesDir)).sort(),
      ['working-1.jsonl', 'working-2.jsonl'],
      'the empty ordinal-2 reservation was pruned and its slot reused, not left as a 3rd file',
    );
    assert.deepEqual((await second.findResumable('g', 'working'))?.messages, [
      msg('assistant', 'b'),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('begin never prunes an empty ordinal it reserved itself in the same process', async () => {
  const dir = await tmp();
  try {
    const store = new TranscriptStore(dir);
    await store.begin({ group: 'g', stage: 'working' }); // ordinal 1, reserved, never written
    await store.begin({ group: 'g', stage: 'working' }); // its own prune pass must skip ordinal 1

    const filesDir = join(dir, 'transcripts', 'g');
    assert.deepEqual(
      (await readdir(filesDir)).sort(),
      ['working-1.jsonl', 'working-2.jsonl'],
      'same-process reservations survive pruning even while still empty',
    );
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

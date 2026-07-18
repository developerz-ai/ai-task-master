// Integration: mid-write crash → resume reads last good state.
//
// aitm's only durability primitive is atomicWrite (fs/atomic-write.ts): temp file + fsync +
// rename + parent-dir fsync. StateStore and TranscriptStore build .ai-task-master/ persistence on
// top of it. This file exercises the crash boundary those modules promise to survive, using the
// same fault-injection technique as fs/atomic-write.test.ts (patching FileHandle.prototype.sync,
// the shared module boundary) plus direct filesystem surgery to model what a `kill -9` actually
// leaves behind: an orphaned `.tmp` file nobody ran cleanup code for, or a transcript line cut off
// mid-flush. Every scenario re-opens the state dir with a FRESH StateStore/TranscriptStore
// instance afterward — the same thing a resumed process does — and asserts it reads the last
// completed write, never a partial one.
//
// docs/plans/2026/07/17/101-aitm-audit-remediation/07-tests.md success criterion 4: "mid-write
// crash loses no completed rename, leaves no orphan temp; corrupt transcript line skips+warns".

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { appendFile, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ModelMessage } from 'ai';
import { type RunState, RunStateSchema } from '../../src/state/schema.ts';
import { StateStore } from '../../src/state/state-store.ts';
import { TranscriptStore } from '../../src/state/transcript-store.ts';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';

function baseState(overrides: Partial<RunState> = {}): RunState {
  return RunStateSchema.parse({
    status: 'planning',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'crash-durability-run',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
    ...overrides,
  });
}

const msg = (role: 'user' | 'assistant', text: string): ModelMessage => ({ role, content: text });

// Arms a one-shot fault on FileHandle.prototype.sync: the next call throws `err`, every call
// before or after runs the real implementation untouched. Mirrors the crash instant a `kill -9`
// models — the process dies between the file write landing on disk and the rename that would have
// made it visible, so atomicWrite's own catch (rm the orphan tmp, rethrow) is what runs, not a
// clean unwind of StateStore.update().
async function withArmedSyncFault<T>(err: Error, body: () => Promise<T>): Promise<T> {
  const probePath = join(tmpdir(), `sync-probe-${randomUUID()}`);
  const probe = await open(probePath, 'w');
  const proto = Object.getPrototypeOf(probe) as { sync: (this: FileHandle) => Promise<void> };
  const real = proto.sync;
  await probe.close();
  await rm(probePath, { force: true });
  let armed = true;
  proto.sync = async function armedSync(this: FileHandle) {
    if (armed) {
      armed = false;
      throw err;
    }
    return real.call(this);
  };
  try {
    return await body();
  } finally {
    proto.sync = real;
  }
}

async function tmpArtifacts(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

test('crash-durability: fsync failure before rename leaves prior state.json intact, no orphan tmp, resume reads last good state', async () => {
  const repo = await makeTempRepo();
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    await store.init(baseState({ status: 'planning' }));
    await store.update((s) => ({ ...s, status: 'working' }));

    const crashErr = Object.assign(new Error('power loss mid-fsync'), { code: 'EIO' });
    await withArmedSyncFault(crashErr, async () => {
      await assert.rejects(
        store.update((s) => ({ ...s, status: 'awaiting-pr' })),
        /power loss mid-fsync/,
      );
    });

    // atomicWrite's own failure path removes the orphan temp it created before rethrowing.
    assert.deepEqual(
      await tmpArtifacts(stateDir),
      [],
      'a failed write must not leave a .tmp file behind',
    );

    // Resume: a fresh StateStore (new process) must read the last COMPLETED write, not a partial
    // or missing one — the crashed write never renamed, so state.json is still the pre-crash value.
    const resumed = new StateStore(stateDir);
    const state = await resumed.read();
    assert.equal(
      state.status,
      'working',
      'resume must read the last good state, not the crashed one',
    );

    // The store must remain usable after the crash — the next write is not poisoned by the failure.
    const recovered = await resumed.update((s) => ({ ...s, status: 'awaiting-pr' }));
    assert.equal(recovered.status, 'awaiting-pr');
  } finally {
    await repo.cleanup();
  }
});

test('crash-durability: an orphaned .tmp file left by a hard kill does not block or corrupt resume', async () => {
  const repo = await makeTempRepo();
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    await store.init(baseState({ status: 'planning' }));
    await store.update((s) => ({ ...s, status: 'working', sessionCount: 1 }));

    // A `kill -9` between the write landing and the rename runs no unwind code at all — unlike the
    // fault-injection case above, the orphan temp is never cleaned up. Model that directly: drop a
    // garbage file matching atomicWrite's naming convention next to the real state.json.
    const orphan = join(stateDir, `state.json.${randomUUID()}.tmp`);
    await appendFile(orphan, '{"status":"working","sessionCount":2, // truncated garbage');

    // Resume: the orphan must be inert — read() only ever looks at state.json.
    const resumed = new StateStore(stateDir);
    const state = await resumed.read();
    assert.equal(state.status, 'working');
    assert.equal(state.sessionCount, 1, 'orphan tmp content must never be read as live state');

    // Further writes must succeed despite the orphan sharing the directory (distinct random
    // suffix per atomicWrite call means no collision).
    const next = await resumed.update((s) => ({ ...s, sessionCount: 2 }));
    assert.equal(next.sessionCount, 2);

    const reread = await resumed.read();
    assert.equal(reread.sessionCount, 2);
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// TranscriptStore
// ---------------------------------------------------------------------------

test('crash-durability: a transcript line truncated mid-append by a crash is skipped; prior steps resume intact', async () => {
  const repo = await makeTempRepo();
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    const warns: string[] = [];
    const transcripts = new TranscriptStore(stateDir, (m) => warns.push(m));

    const recorder = await transcripts.begin({ group: 'group-a', stage: 'working' });
    await recorder.step([msg('user', 'do the task')]);
    await recorder.step([msg('assistant', 'working on it')]);

    // Find the file begin()/step() just wrote to, then simulate the crash: appendFile writing the
    // NEXT record only got partway to disk before power loss, leaving a truncated, unparseable tail
    // (no closing brace, no trailing newline) after the two good lines.
    const groupDir = join(stateDir, 'transcripts', 'group-a');
    const [file] = (await readdir(groupDir)).filter((f) => f.startsWith('working-'));
    assert.ok(file, 'expected one working-*.jsonl transcript file');
    const transcriptPath = join(groupDir, file);
    await appendFile(transcriptPath, '\n{"kind":"step","ts":"t3","messages":[{"role":"assist');

    // Resume: a fresh TranscriptStore (new process) must reconstruct only the complete steps.
    const resumedWarns: string[] = [];
    const resumed = new TranscriptStore(stateDir, (m) => resumedWarns.push(m));
    const result = await resumed.findResumable('group-a', 'working');
    assert.ok(result !== null, 'an interrupted transcript with good steps must be resumable');
    assert.deepEqual(result.messages, [
      msg('user', 'do the task'),
      msg('assistant', 'working on it'),
    ]);
    assert.ok(
      resumedWarns.length > 0,
      'the truncated tail must be warned about, not silently dropped',
    );
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Combined: StateStore + TranscriptStore crash together, one resume
// ---------------------------------------------------------------------------

test('crash-durability: state write and transcript append crash together; resume reads the last good state and transcript', async () => {
  const repo = await makeTempRepo();
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    await store.init(baseState({ status: 'planning' }));
    await store.update((s) => ({ ...s, status: 'working' }));

    const transcripts = store.transcripts();
    const recorder = await transcripts.begin({ group: 'group-a', stage: 'working' });
    await recorder.step([msg('user', 'goal: add hello')]);

    // Crash: the in-flight state update loses its fsync (before rename) at the same instant the
    // in-flight transcript append gets cut off mid-line — both artifacts a real `kill -9` between
    // two nearly-simultaneous writes would produce.
    const crashErr = Object.assign(new Error('power loss'), { code: 'EIO' });
    await withArmedSyncFault(crashErr, async () => {
      await assert.rejects(store.update((s) => ({ ...s, status: 'awaiting-pr', currentPr: 7 })));
    });
    const groupDir = join(stateDir, 'transcripts', 'group-a');
    const [file] = (await readdir(groupDir)).filter((f) => f.startsWith('working-'));
    assert.ok(file, 'expected one working-*.jsonl transcript file');
    await appendFile(join(groupDir, file), '\n{"kind":"step","ts":"crash","messages":[{"rol');

    // No orphan tmp from the crashed state write.
    assert.deepEqual(await tmpArtifacts(stateDir), []);

    // Resume with fresh instances against the same dir — the production restart path.
    const resumedStore = new StateStore(stateDir);
    const resumedState = await resumedStore.read();
    assert.equal(resumedState.status, 'working', 'resume must see the last committed status');
    assert.equal(
      resumedState.currentPr,
      null,
      'the crashed update must not have partially applied',
    );

    const resumedTranscripts = resumedStore.transcripts();
    const resumable = await resumedTranscripts.findResumable('group-a', 'working');
    assert.ok(resumable !== null);
    assert.deepEqual(resumable.messages, [msg('user', 'goal: add hello')]);

    // The run continues normally after resume: further state and transcript writes succeed. A new
    // ordinal is reserved for the target rather than appending onto the crash-tailed file, so the
    // corrupt tail can never resurface into a live conversation.
    const advanced = await resumedStore.update((s) => ({
      ...s,
      status: 'awaiting-pr',
      currentPr: 7,
    }));
    assert.equal(advanced.currentPr, 7);
    const resumedRecorder = await resumedTranscripts.begin({ group: 'group-a', stage: 'working' });
    await resumedRecorder.step([msg('assistant', 'created hello.ts')]);
    await resumedRecorder.end('submitted');

    const raw = await readFile(join(groupDir, 'working-2.jsonl'), 'utf8');
    assert.match(raw, /"kind":"run-end"/);
    assert.doesNotMatch(
      raw,
      /crash/,
      'the fresh transcript must not carry the crash-tailed content',
    );
  } finally {
    await repo.cleanup();
  }
});

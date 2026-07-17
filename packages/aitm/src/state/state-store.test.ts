import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempRepo } from '../testing/temp-repo.ts';
import { type RunState, RunStateSchema } from './schema.ts';
import { StateStore } from './state-store.ts';

function baseState(overrides: Partial<RunState> = {}): RunState {
  return RunStateSchema.parse({
    status: 'planning',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: '01HFAKERUNID0000000000000',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
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

// A pre-stage-machine PrGroup as it appears on disk: structured tasks but no `stage` field.
function legacyGroup(props: {
  id: string;
  status: string;
  pr: number | null;
}): Record<string, unknown> {
  return {
    id: props.id,
    title: props.id,
    tasks: [],
    dependsOn: [],
    branch: null,
    pr: props.pr,
    status: props.status,
  };
}

test('StateStore is constructible', () => {
  const s = new StateStore('/tmp/repo/.ai-task-master');
  assert.ok(s instanceof StateStore);
});

test('init writes state.json and creates logs/ dir', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());
    const written = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(written.runId, '01HFAKERUNID0000000000000');
    const logsStat = await stat(join(dir, 'logs'));
    assert.ok(logsStat.isDirectory());
  } finally {
    await repo.cleanup();
  }
});

test('read returns the validated state written by init', async () => {
  const repo = await makeTempRepo();
  try {
    const store = new StateStore(join(repo.path, '.ai-task-master'));
    await store.init(baseState({ status: 'working' }));
    const read = await store.read();
    assert.equal(read.status, 'working');
    assert.equal(read.provider, 'openrouter');
  } finally {
    await repo.cleanup();
  }
});

test('read rejects invalid JSON', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());
    await writeFile(join(dir, 'state.json'), '{not json');
    await assert.rejects(() => store.read(), /invalid JSON/);
  } finally {
    await repo.cleanup();
  }
});

test('read rejects state failing the schema', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());
    await writeFile(join(dir, 'state.json'), JSON.stringify({ foo: 'bar' }));
    await assert.rejects(() => store.read());
  } finally {
    await repo.cleanup();
  }
});

test('read: coerces legacy string[] tasks, leaves structured tasks intact', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());

    // Older state.json stored prGroups[].tasks as a bare string[]. Mix in one already-structured
    // task to prove coercion only rewrites strings.
    const legacy: Record<string, unknown> = JSON.parse(JSON.stringify(baseState()));
    legacy.prGroups = [
      {
        id: 'g1',
        title: 'Group one',
        tasks: [
          'Add the login form',
          { id: 'kept', text: 'Already structured', complexity: 'complex', done: true },
        ],
        dependsOn: [],
        branch: null,
        pr: null,
        status: 'pending',
      },
    ];
    await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));

    const read = await store.read();
    assert.deepEqual(read.prGroups[0]?.tasks, [
      { id: 'add-the-login-form', text: 'Add the login form', complexity: 'normal', done: false },
      { id: 'kept', text: 'Already structured', complexity: 'complex', done: true },
    ]);
  } finally {
    await repo.cleanup();
  }
});

test('read: infers a missing group stage from status/pr', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());

    // Pre-stage-machine state.json carried no PrGroup.stage. On read it must be inferred:
    // merged → merged, open PR → waiting-ci, otherwise → pending.
    const legacy: Record<string, unknown> = JSON.parse(JSON.stringify(baseState()));
    legacy.prGroups = [
      legacyGroup({ id: 'done', status: 'merged', pr: 5 }),
      legacyGroup({ id: 'open', status: 'in-progress', pr: 9 }),
      legacyGroup({ id: 'fresh', status: 'pending', pr: null }),
    ];
    await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));

    const read = await store.read();
    assert.equal(read.prGroups[0]?.stage, 'merged');
    assert.equal(read.prGroups[1]?.stage, 'waiting-ci');
    assert.equal(read.prGroups[2]?.stage, 'pending');
  } finally {
    await repo.cleanup();
  }
});

test('read: a legacy blocked group stays blocked (not reclassified runnable)', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());

    // A pre-stage-machine terminal `blocked` group: status blocked, and a pr set (which would
    // otherwise infer 'waiting-ci'). It must stay blocked so resume doesn't re-run halted work.
    const legacy: Record<string, unknown> = JSON.parse(JSON.stringify(baseState()));
    legacy.prGroups = [legacyGroup({ id: 'stuck', status: 'blocked', pr: 7 })];
    await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));

    const read = await store.read();
    assert.equal(read.prGroups[0]?.stage, 'blocked');
    assert.equal(read.prGroups[0]?.status, 'blocked');
  } finally {
    await repo.cleanup();
  }
});

test('read: preserves an existing group stage instead of inferring', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());

    const legacy: Record<string, unknown> = JSON.parse(JSON.stringify(baseState()));
    // pr is set (would infer waiting-ci) but an explicit stage must win.
    legacy.prGroups = [
      { ...legacyGroup({ id: 'g', status: 'in-progress', pr: 3 }), stage: 'ready-to-merge' },
    ];
    await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));

    const read = await store.read();
    assert.equal(read.prGroups[0]?.stage, 'ready-to-merge');
  } finally {
    await repo.cleanup();
  }
});

test('update bumps updatedAt and persists mutation', async () => {
  const repo = await makeTempRepo();
  try {
    const store = new StateStore(join(repo.path, '.ai-task-master'));
    await store.init(baseState());
    const before = await store.read();
    // Ensure a measurable tick passes so the ISO string differs.
    await new Promise((r) => setTimeout(r, 5));
    const after = await store.update((s) => ({ ...s, sessionCount: s.sessionCount + 1 }));
    assert.equal(after.sessionCount, 1);
    assert.notEqual(after.updatedAt, before.updatedAt);
    const reread = await store.read();
    assert.equal(reread.sessionCount, 1);
    assert.equal(reread.updatedAt, after.updatedAt);
  } finally {
    await repo.cleanup();
  }
});

test('update validates the mutator output before writing', async () => {
  const repo = await makeTempRepo();
  try {
    const store = new StateStore(join(repo.path, '.ai-task-master'));
    await store.init(baseState());
    await assert.rejects(() => store.update((s) => ({ ...s, sessionCount: -1 })));
    // File on disk must remain the last valid version.
    const reread = await store.read();
    assert.equal(reread.sessionCount, 0);
  } finally {
    await repo.cleanup();
  }
});

test('concurrent update() calls serialize — no lost updates', async () => {
  const repo = await makeTempRepo();
  try {
    const store = new StateStore(join(repo.path, '.ai-task-master'));
    await store.init(baseState());
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        store.update((s) => ({ ...s, sessionCount: s.sessionCount + 1 })),
      ),
    );
    // Each mutation observed the prior write — final value reflects every increment.
    const final = await store.read();
    assert.equal(final.sessionCount, N);
    // The last-resolved result equals the on-disk state (chain preserves order).
    const last = results[results.length - 1];
    assert.ok(last);
    assert.equal(last.sessionCount, N);
    assert.equal(last.updatedAt, final.updatedAt);
    // updatedAt is monotonically non-decreasing across the chain.
    let prev = '';
    for (const r of results) {
      assert.ok(r.updatedAt >= prev);
      prev = r.updatedAt;
    }
  } finally {
    await repo.cleanup();
  }
});

test('update survives a failing mutator without poisoning subsequent calls', async () => {
  const repo = await makeTempRepo();
  try {
    const store = new StateStore(join(repo.path, '.ai-task-master'));
    await store.init(baseState());
    await assert.rejects(() =>
      store.update(() => {
        throw new Error('boom');
      }),
    );
    const ok = await store.update((s) => ({ ...s, sessionCount: s.sessionCount + 1 }));
    assert.equal(ok.sessionCount, 1);
  } finally {
    await repo.cleanup();
  }
});

test('writeGoal writes goal.txt and optional criteria.txt with trailing newline', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.writeGoal('ship feature X');
    assert.equal(await readFile(join(dir, 'goal.txt'), 'utf8'), 'ship feature X\n');
    await assert.rejects(() => readFile(join(dir, 'criteria.txt'), 'utf8'));

    await store.writeGoal('ship feature X', 'tests pass\ncoverage > 80');
    assert.equal(await readFile(join(dir, 'criteria.txt'), 'utf8'), 'tests pass\ncoverage > 80\n');
  } finally {
    await repo.cleanup();
  }
});

test('writePlan renders checkbox markdown with per-task state', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.writePlan([
      {
        title: 'core',
        tasks: [
          { text: 'first task', complexity: 'normal', done: true },
          { text: 'second task', complexity: 'complex', done: false },
        ],
      },
    ]);
    assert.equal(
      await readFile(join(dir, 'plan.md'), 'utf8'),
      '## Group: core\n- [x] [NORMAL] first task\n- [ ] [COMPLEX] second task\n',
    );
  } finally {
    await repo.cleanup();
  }
});

test('appendProgress appends successive entries', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.appendProgress('entry one');
    await store.appendProgress('entry two');
    assert.equal(await readFile(join(dir, 'progress.md'), 'utf8'), 'entry one\nentry two\n');
  } finally {
    await repo.cleanup();
  }
});

test('concurrent appendProgress calls serialize — entries stay intact and ordered', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    const N = 20;
    const entries = Array.from({ length: N }, (_, i) => `entry ${i}`);
    // Fire all appends at once. A bare appendFile per call would race on the file offset — lines could
    // interleave or land out of order. The per-store chain keeps each entry intact and in order.
    await Promise.all(entries.map((e) => store.appendProgress(e)));
    const written = await readFile(join(dir, 'progress.md'), 'utf8');
    assert.equal(written, `${entries.join('\n')}\n`);
  } finally {
    await repo.cleanup();
  }
});

test('writeContext + readContext round-trip', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    assert.equal(await store.readContext(), null);
    await store.writeContext('rolling summary');
    assert.equal(await store.readContext(), 'rolling summary\n');
  } finally {
    await repo.cleanup();
  }
});

test('writeCodingStyle + readCodingStyle round-trip', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    assert.equal(await store.readCodingStyle(), null);
    await store.writeCodingStyle('# Coding Style\n\nUse tabs');
    assert.equal(await store.readCodingStyle(), '# Coding Style\n\nUse tabs\n');
  } finally {
    await repo.cleanup();
  }
});

test('cleanupOnSuccess removes everything except logs/', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());
    await store.writeGoal('g', 'c');
    await store.writePlan([
      { title: 'g', tasks: [{ text: 't', complexity: 'normal', done: false }] },
    ]);
    await store.appendProgress('progress entry');
    await store.writeContext('ctx');
    await store.writeCodingStyle('# style');
    // Drop a log file so we can prove logs/ survives.
    await writeFile(join(dir, 'logs', 'run-x.log'), 'log line\n');

    await store.cleanupOnSuccess();

    const remaining = (await readdir(dir)).sort();
    assert.deepEqual(remaining, ['logs']);
    assert.equal(await readFile(join(dir, 'logs', 'run-x.log'), 'utf8'), 'log line\n');
  } finally {
    await repo.cleanup();
  }
});

test('cleanupOnSuccess preserves memory/ alongside logs/ (issue #118)', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());
    await store.writeContext('ctx');
    // Seed a durable memory under the accessor path.
    assert.equal(store.memoryDir(), join(dir, 'memory'));
    await mkdir(store.memoryDir(), { recursive: true });
    await writeFile(join(store.memoryDir(), 'flaky-ci.md'), 'fact\n');

    await store.cleanupOnSuccess();

    const remaining = (await readdir(dir)).sort();
    assert.deepEqual(remaining, ['logs', 'memory']);
    assert.equal(await readFile(join(store.memoryDir(), 'flaky-ci.md'), 'utf8'), 'fact\n');
  } finally {
    await repo.cleanup();
  }
});

test('cleanupOnSuccess removes transcripts/ along with the rest of the state dir (issue #108)', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);
    await store.init(baseState());
    // Record a transcript, then confirm cleanup wipes it (unlike logs/ and memory/, it is not exempt).
    const rec = await store.transcripts().begin({ group: 'core', stage: 'working' });
    await rec.step([{ role: 'user', content: 'goal' }]);
    assert.ok(await readFile(join(dir, 'transcripts', 'core', 'working-1.jsonl'), 'utf8'));

    await store.cleanupOnSuccess();

    const remaining = (await readdir(dir)).sort();
    assert.ok(!remaining.includes('transcripts'), 'transcripts/ wiped on success');
    assert.deepEqual(remaining, ['logs']);
  } finally {
    await repo.cleanup();
  }
});

test('cleanupOnSuccess is a no-op when stateDir does not exist', async () => {
  const repo = await makeTempRepo();
  try {
    const store = new StateStore(join(repo.path, '.ai-task-master'));
    await store.cleanupOnSuccess();
  } finally {
    await repo.cleanup();
  }
});

test('round-trip: init → read → update → cleanup', async () => {
  const repo = await makeTempRepo();
  try {
    const dir = join(repo.path, '.ai-task-master');
    const store = new StateStore(dir);

    await store.init(baseState());
    const initial = await store.read();
    assert.equal(initial.sessionCount, 0);

    const bumped = await store.update((s) => ({
      ...s,
      sessionCount: s.sessionCount + 1,
      status: 'working',
    }));
    assert.equal(bumped.status, 'working');
    assert.equal(bumped.sessionCount, 1);

    await store.cleanupOnSuccess();
    await assert.rejects(() => store.read());
    const remaining = (await readdir(dir)).sort();
    assert.deepEqual(remaining, ['logs']);
  } finally {
    await repo.cleanup();
  }
});

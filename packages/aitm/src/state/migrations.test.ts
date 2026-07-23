import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateState, UnsupportedSchemaVersion } from './migrations.ts';
import { CURRENT_SCHEMA_VERSION, RunStateSchema } from './schema.ts';

const PATH = '/repo/.ai-task-master/state.json';

// A v0 (pre-versioning) state.json: no schemaVersion, string[] tasks, no PrGroup.stage.
function v0(prGroups: unknown[]): Record<string, unknown> {
  return {
    status: 'working',
    prGroups,
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 1,
    currentPr: null,
    runId: 'run-v0',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
  };
}

function v0Group(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'g1',
    title: 'Group one',
    tasks: [],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    ...over,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function field(value: unknown, name: string): unknown {
  if (!isRecord(value)) return assert.fail(`expected a record to read ${name} from`);
  return value[name];
}

function groupsOf(migrated: unknown): unknown[] {
  const prGroups = field(migrated, 'prGroups');
  assert.ok(Array.isArray(prGroups), 'migrated state must keep prGroups an array');
  return prGroups;
}

function firstGroup(migrated: unknown): unknown {
  const group = groupsOf(migrated)[0];
  assert.ok(group !== undefined, 'migrated state must keep prGroups[0]');
  return group;
}

test('migrations: an unversioned state.json → stamped with the current schema version', () => {
  const migrated = migrateState(v0([]), PATH);
  assert.equal(field(migrated, 'schemaVersion'), CURRENT_SCHEMA_VERSION);
});

test('migrations: v0 string tasks → structured Tasks with slug ids', () => {
  const migrated = migrateState(v0([v0Group({ tasks: ['Add the login form'] })]), PATH);
  assert.deepEqual(field(firstGroup(migrated), 'tasks'), [
    { id: 'add-the-login-form', text: 'Add the login form', complexity: 'normal', done: false },
  ]);
});

test('migrations: v0 task text with no slug characters → positional fallback id', () => {
  const migrated = migrateState(v0([v0Group({ tasks: ['!!!', '???'] })]), PATH);
  assert.deepEqual(field(firstGroup(migrated), 'tasks'), [
    { id: 'task-1', text: '!!!', complexity: 'normal', done: false },
    { id: 'task-2', text: '???', complexity: 'normal', done: false },
  ]);
});

test('migrations: v0 already-structured tasks → passed through untouched', () => {
  const kept = { id: 'kept', text: 'Already structured', complexity: 'complex', done: true };
  const migrated = migrateState(v0([v0Group({ tasks: [kept, 'and a string one'] })]), PATH);
  const tasks = field(firstGroup(migrated), 'tasks');
  assert.ok(Array.isArray(tasks));
  assert.deepEqual(tasks[0], kept);
  assert.deepEqual(tasks[1], {
    id: 'and-a-string-one',
    text: 'and a string one',
    complexity: 'normal',
    done: false,
  });
});

test('migrations: v0 missing stage → inferred from status and pr', () => {
  const migrated = migrateState(
    v0([
      v0Group({ id: 'done', status: 'merged', pr: 5 }),
      v0Group({ id: 'open', status: 'in-progress', pr: 9 }),
      v0Group({ id: 'stuck', status: 'blocked', pr: 7 }),
      v0Group({ id: 'fresh', status: 'pending', pr: null }),
    ]),
    PATH,
  );
  assert.deepEqual(
    groupsOf(migrated).map((g) => field(g, 'stage')),
    ['merged', 'waiting-ci', 'blocked', 'pending'],
  );
});

test('migrations: v0 group with an explicit stage → stage preserved, never re-inferred', () => {
  const migrated = migrateState(
    v0([v0Group({ status: 'in-progress', pr: 3, stage: 'ready-to-merge' })]),
    PATH,
  );
  assert.equal(field(firstGroup(migrated), 'stage'), 'ready-to-merge');
});

test('migrations: migrating twice → identical result (already-current state is not re-lifted)', () => {
  const once = migrateState(v0([v0Group({ tasks: ['Add the login form'], pr: 4 })]), PATH);
  const twice = migrateState(once, PATH);
  assert.deepEqual(twice, once);
});

test('migrations: a current-version state → returned unchanged but for the stamp', () => {
  const current = { ...v0([v0Group({ tasks: [] })]), schemaVersion: CURRENT_SCHEMA_VERSION };
  assert.deepEqual(migrateState(current, PATH), current);
});

test('migrations: v0 output → parses as a RunState', () => {
  const parsed = RunStateSchema.parse(
    migrateState(v0([v0Group({ tasks: ['ship it'], status: 'merged', pr: 2 })]), PATH),
  );
  assert.equal(parsed.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(parsed.prGroups[0]?.stage, 'merged');
  assert.equal(parsed.prGroups[0]?.tasks[0]?.text, 'ship it');
});

test('migrations: state from a newer aitm → UnsupportedSchemaVersion naming the file', () => {
  const future = { ...v0([]), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
  assert.throws(
    () => migrateState(future, PATH),
    (err: unknown) => {
      assert.ok(err instanceof UnsupportedSchemaVersion);
      assert.equal(err.found, CURRENT_SCHEMA_VERSION + 1);
      assert.ok(err.message.includes(PATH), 'message must name the offending file');
      // The `${path}:` prefix means "corrupt, safe to discard" to callers — a newer run is neither.
      assert.ok(
        !err.message.startsWith(`${PATH}:`),
        'message must not read as a corrupt-state error',
      );
      return true;
    },
  );
});

test('migrations: an unreadable schemaVersion → refused rather than guessed at', () => {
  for (const found of ['1', 1.5, -1, null, Number.NaN, {}]) {
    assert.throws(
      () => migrateState({ ...v0([]), schemaVersion: found }, PATH),
      UnsupportedSchemaVersion,
      `schemaVersion ${JSON.stringify(found)} must be refused`,
    );
  }
});

test('migrations: a non-record value → passed through for the schema to reject', () => {
  assert.equal(migrateState(null, PATH), null);
  assert.equal(migrateState('nope', PATH), 'nope');
  assert.deepEqual(migrateState([], PATH), []);
});

test('migrations: a v0 state with no prGroups array → stamped, otherwise untouched', () => {
  const migrated = migrateState({ status: 'planning' }, PATH);
  assert.deepEqual(migrated, { status: 'planning', schemaVersion: CURRENT_SCHEMA_VERSION });
});

test('migrations: a v0 group that is not a record → left for the schema to reject', () => {
  const migrated = migrateState(v0(['not a group']), PATH);
  assert.deepEqual(groupsOf(migrated), ['not a group']);
});

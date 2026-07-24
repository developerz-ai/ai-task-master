import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupStageSchema, PrGroupSchema } from './pr-group.ts';

test('PrGroupSchema defaults dependsOn to []', () => {
  const parsed = PrGroupSchema.parse({
    id: 'auth-models',
    title: 'auth models',
    tasks: [{ id: 'add-user-table', text: 'add User table', complexity: 'normal', done: false }],
    branch: null,
    pr: null,
    status: 'pending',
  });
  assert.deepEqual(parsed.dependsOn, []);
});

test('PrGroupSchema accepts dependsOn with ids', () => {
  const parsed = PrGroupSchema.parse({
    id: 'auth-routes',
    title: 'auth routes',
    tasks: [{ id: 'post-login', text: 'POST /login', complexity: 'normal', done: false }],
    dependsOn: ['auth-models'],
    branch: null,
    pr: null,
    status: 'pending',
  });
  assert.deepEqual(parsed.dependsOn, ['auth-models']);
});

test('PrGroupSchema defaults stage to pending', () => {
  const parsed = PrGroupSchema.parse({
    id: 'auth-models',
    title: 'auth models',
    tasks: [],
    branch: null,
    pr: null,
    status: 'pending',
  });
  assert.equal(parsed.stage, 'pending');
});

test('PrGroupSchema accepts an explicit stage', () => {
  const parsed = PrGroupSchema.parse({
    id: 'auth-models',
    title: 'auth models',
    tasks: [],
    branch: null,
    pr: 7,
    status: 'in-progress',
    stage: 'waiting-ci',
  });
  assert.equal(parsed.stage, 'waiting-ci');
});

test('GroupStageSchema rejects an unknown stage', () => {
  assert.throws(() => GroupStageSchema.parse('deploying'));
});

test('PrGroupSchema: ciFixAttempts/humanNeeded are optional (legacy state parses) and round-trip (issue #128)', () => {
  const base = {
    id: 'auth-models',
    title: 'auth models',
    tasks: [],
    branch: null,
    pr: 7,
    status: 'awaiting-pr' as const,
    stage: 'ci-failed' as const,
  };
  // A pre-#128 group (no durable fix-attempt fields) still parses.
  const legacy = PrGroupSchema.parse(base);
  assert.equal(legacy.ciFixAttempts, undefined);
  assert.equal(legacy.humanNeeded, undefined);
  // Persisted values round-trip.
  const parked = PrGroupSchema.parse({ ...base, ciFixAttempts: 3, humanNeeded: true });
  assert.equal(parked.ciFixAttempts, 3);
  assert.equal(parked.humanNeeded, true);
  // A negative or non-integer attempt count is rejected.
  assert.throws(() => PrGroupSchema.parse({ ...base, ciFixAttempts: -1 }));
  assert.throws(() => PrGroupSchema.parse({ ...base, ciFixAttempts: 1.5 }));
});

test('PrGroupSchema persists the acceptance check when the plan carried one', () => {
  const parsed = PrGroupSchema.parse({
    id: 'auth-routes',
    title: 'auth routes',
    acceptance: 'POST /login sets a session cookie',
    tasks: [],
    branch: null,
    pr: null,
    status: 'pending',
  });
  assert.equal(parsed.acceptance, 'POST /login sets a session cookie');
});

test('PrGroupSchema: legacy state without an acceptance check still loads', () => {
  const parsed = PrGroupSchema.parse({
    id: 'auth-routes',
    title: 'auth routes',
    tasks: [],
    branch: null,
    pr: null,
    status: 'pending',
  });
  assert.equal(parsed.acceptance, undefined);
});

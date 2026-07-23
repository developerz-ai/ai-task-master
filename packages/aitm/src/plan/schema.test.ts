import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlannedGroupSchema, PlannedTaskSchema, PlanSchema } from './schema.ts';

test('PlannedTaskSchema defaults complexity to normal', () => {
  const parsed = PlannedTaskSchema.parse({ description: 't1' });
  assert.equal(parsed.complexity, 'normal');
});

test('PlannedTaskSchema accepts an explicit complexity', () => {
  const parsed = PlannedTaskSchema.parse({ description: 't1', complexity: 'complex' });
  assert.equal(parsed.complexity, 'complex');
});

test('PlannedTaskSchema rejects an unknown complexity', () => {
  assert.throws(() => PlannedTaskSchema.parse({ description: 't1', complexity: 'huge' }));
});

test('PlannedGroupSchema defaults dependsOn to []', () => {
  const parsed = PlannedGroupSchema.parse({
    id: 'g1',
    title: 'g',
    tasks: [{ description: 't1' }],
    acceptance: 'bun test passes',
  });
  assert.deepEqual(parsed.dependsOn, []);
});

test('PlannedGroupSchema requires an acceptance check', () => {
  // Required on purpose: a group with no check is a group nothing can hold to account, so the
  // schema-retry loop re-asks for one instead of the harness silently dropping it.
  assert.throws(() =>
    PlannedGroupSchema.parse({ id: 'g1', title: 'g', tasks: [{ description: 't1' }] }),
  );
  assert.throws(() =>
    PlannedGroupSchema.parse({
      id: 'g1',
      title: 'g',
      tasks: [{ description: 't1' }],
      acceptance: '',
    }),
  );
});

test('PlannedGroupSchema describes the acceptance check with an executable example', () => {
  // The description is what the schema-retry loop re-asks with, so it must name the shape of an
  // answer (a command / an observable), not just the field.
  const described = PlannedGroupSchema.shape.acceptance.description ?? '';
  assert.match(described, /command|observ/i);
  assert.ok(described.includes('bun test src/auth passes'), 'carries a concrete example');
});

test('PlanSchema validates a minimal plan', () => {
  const plan = PlanSchema.parse({
    goal: 'add jwt auth',
    groups: [
      {
        id: 'g1',
        title: 'models',
        tasks: [{ description: 'add User' }],
        acceptance: 'bun test src/models passes',
      },
      {
        id: 'g2',
        title: 'routes',
        tasks: [{ description: 'POST /login', filesHint: ['src/routes/login.ts'] }],
        acceptance: 'POST /login sets a session cookie',
        dependsOn: ['g1'],
      },
    ],
  });
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.groups[1]?.dependsOn, ['g1']);
  assert.equal(plan.groups[1]?.acceptance, 'POST /login sets a session cookie');
});

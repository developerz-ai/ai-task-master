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
  });
  assert.deepEqual(parsed.dependsOn, []);
});

test('PlanSchema validates a minimal plan', () => {
  const plan = PlanSchema.parse({
    goal: 'add jwt auth',
    groups: [
      { id: 'g1', title: 'models', tasks: [{ description: 'add User' }] },
      {
        id: 'g2',
        title: 'routes',
        tasks: [{ description: 'POST /login', filesHint: ['src/routes/login.ts'] }],
        dependsOn: ['g1'],
      },
    ],
  });
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.groups[1]?.dependsOn, ['g1']);
});

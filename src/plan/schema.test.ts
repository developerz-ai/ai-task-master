import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlannedGroupSchema, PlanSchema } from './schema.ts';

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

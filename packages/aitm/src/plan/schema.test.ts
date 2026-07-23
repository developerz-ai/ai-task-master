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

test('PlannedGroupSchema rejects a group with no tasks', () => {
  // A group with an empty task list is a PR with nothing in it — cheaper to re-ask than to run.
  assert.throws(() =>
    PlannedGroupSchema.parse({ id: 'g1', title: 'g', tasks: [], acceptance: 'bun test passes' }),
  );
});

test('PlannedGroupSchema caps a group at 5 tasks', () => {
  const task = { description: 'add todo CRUD repository, services, and routes with unit tests' };
  const five = { id: 'g1', title: 'g', tasks: Array(5).fill(task), acceptance: 'bun test passes' };
  assert.equal(PlannedGroupSchema.parse(five).tasks.length, 5);
  // Past five, the group was split by file rather than by behaviour — the shape that made every
  // task pay a full repo survey to write ~40 lines. The schema-retry loop re-asks for merged slices.
  assert.throws(() => PlannedGroupSchema.parse({ ...five, tasks: Array(6).fill(task) }));
});

test('PlannedTaskSchema describes a task as a multi-file behaviour slice with its tests', () => {
  // This describe text reaches the model as tool-input JSON schema while it fills the field, so it
  // must carry the sizing contract itself, not merely echo the field name.
  const described = PlannedTaskSchema.shape.description.description ?? '';
  assert.ok(described.includes('~100-400 lines'), 'names the target size');
  assert.match(described, /never one task per file/i);
  assert.match(described, /with its tests/i);
});

test('PlannedGroupSchema describes tasks as disjoint slices to be merged, never dropped', () => {
  const described = PlannedGroupSchema.shape.tasks.description ?? '';
  assert.match(described, /disjoint/i);
  assert.match(described, /never drop work/i);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskComplexitySchema, TaskSchema } from './task.ts';

test('TaskSchema accepts a full task with subtasks', () => {
  const parsed = TaskSchema.parse({
    id: 't1',
    text: 'wire auth middleware',
    complexity: 'complex',
    done: false,
    subtasks: ['add middleware', 'add tests'],
  });
  assert.equal(parsed.complexity, 'complex');
  assert.deepEqual(parsed.subtasks, ['add middleware', 'add tests']);
});

test('TaskSchema rejects an unknown complexity', () => {
  assert.throws(() =>
    TaskSchema.parse({ id: 't1', text: 'x', complexity: 'trivial', done: false }),
  );
});

test('TaskComplexitySchema accepts the three tiers and rejects anything else', () => {
  for (const tier of ['simple', 'normal', 'complex']) {
    assert.equal(TaskComplexitySchema.parse(tier), tier);
  }
  assert.throws(() => TaskComplexitySchema.parse('trivial'));
});

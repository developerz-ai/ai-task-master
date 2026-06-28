import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrGroupSchema, RunStateSchema, TaskSchema } from './schema.ts';

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

test('RunStateSchema rejects unknown provider', () => {
  assert.throws(() =>
    RunStateSchema.parse({
      status: 'planning',
      prGroups: [],
      currentGroupIndex: 0,
      currentTaskIndex: 0,
      sessionCount: 0,
      currentPr: null,
      runId: 'r1',
      provider: 'anthropic',
      model: 'x',
      agentConfigFile: 'CLAUDE.md',
      createdAt: 'now',
      updatedAt: 'now',
      options: {
        autoMerge: true,
        maxPrs: 5,
        maxSessions: null,
        mergeMethod: 'squash',
        stylePath: null,
        concurrency: 1,
      },
    }),
  );
});

test('RunStateSchema defaults options.prPerTask to false', () => {
  const parsed = RunStateSchema.parse({
    status: 'planning',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'r1',
    provider: 'openrouter',
    model: 'x',
    agentConfigFile: 'CLAUDE.md',
    createdAt: 'now',
    updatedAt: 'now',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
  });
  assert.equal(parsed.options.prPerTask, false);
});

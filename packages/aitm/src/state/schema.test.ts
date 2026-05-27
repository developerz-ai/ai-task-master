import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrGroupSchema, RunStateSchema } from './schema.ts';

test('PrGroupSchema defaults dependsOn to []', () => {
  const parsed = PrGroupSchema.parse({
    id: 'auth-models',
    title: 'auth models',
    tasks: ['add User table'],
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
    tasks: ['POST /login'],
    dependsOn: ['auth-models'],
    branch: null,
    pr: null,
    status: 'pending',
  });
  assert.deepEqual(parsed.dependsOn, ['auth-models']);
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

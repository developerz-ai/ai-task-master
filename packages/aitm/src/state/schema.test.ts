import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GroupStageSchema, PrGroupSchema, RunStateSchema, TaskSchema } from './schema.ts';

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

test('RunStateSchema: usage is optional (legacy state parses) and round-trips when present (issue #114)', () => {
  const base = {
    status: 'success' as const,
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'r1',
    provider: 'openrouter' as const,
    model: 'x',
    agentConfigFile: 'CLAUDE.md' as const,
    createdAt: 'now',
    updatedAt: 'now',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash' as const,
      stylePath: null,
      concurrency: 1,
    },
  };
  // A pre-#114 state.json (no `usage`) still parses.
  assert.equal(RunStateSchema.parse(base).usage, undefined);
  // A run's usage totals round-trip.
  const usage = {
    perRole: {
      worker: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 5,
        calls: 2,
        costUsd: 0.001,
        cacheDiscountUsd: 0.0002,
      },
    },
    overall: {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 5,
      calls: 2,
      costUsd: 0.001,
      cacheDiscountUsd: 0.0002,
    },
  };
  const parsed = RunStateSchema.parse({ ...base, usage });
  assert.deepEqual(parsed.usage, usage);
  // costUsd may be null (any pricing unknown) — still valid.
  const nullCost = RunStateSchema.parse({
    ...base,
    usage: { perRole: {}, overall: { ...usage.overall, costUsd: null } },
  });
  assert.equal(nullCost.usage?.overall.costUsd, null);

  // Pre-slice-04b usage (no cacheWriteInputTokens/cacheDiscountUsd) still parses, defaulting to 0/null.
  const legacyUsage = RunStateSchema.parse({
    ...base,
    usage: {
      perRole: {},
      overall: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, calls: 1, costUsd: null },
    },
  });
  assert.equal(legacyUsage.usage?.overall.cacheWriteInputTokens, 0);
  assert.equal(legacyUsage.usage?.overall.cacheDiscountUsd, null);
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

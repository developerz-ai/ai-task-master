import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURRENT_SCHEMA_VERSION, RunStateSchema } from './schema.ts';

// PrGroup/Task/GroupStage schema coverage lives in src/domain/{pr-group,task}.test.ts, where those
// types now live. This file covers only the persisted RunState envelope.

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

test('RunStateSchema: schemaVersion defaults to current and rejects any other version', () => {
  const base = {
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
  };
  assert.equal(RunStateSchema.parse(base).schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(
    RunStateSchema.parse({ ...base, schemaVersion: CURRENT_SCHEMA_VERSION }).schemaVersion,
    CURRENT_SCHEMA_VERSION,
  );
  // Anything else must reach this schema already lifted by state/migrations.ts.
  assert.throws(() => RunStateSchema.parse({ ...base, schemaVersion: CURRENT_SCHEMA_VERSION + 1 }));
  assert.throws(() => RunStateSchema.parse({ ...base, schemaVersion: 0 }));
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

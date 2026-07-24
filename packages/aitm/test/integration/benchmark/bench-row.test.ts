// Pure tests for the benchmark row shaping (issue #184): state.json → BenchRow, and the JSONL
// round-trip. Always run (no secrets), so the gate verifies them via `test:integration`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunState } from '../../../src/state/schema.ts';
import { buildBenchRow, parseJsonl, toJsonl } from './bench-row.ts';

export function fixtureState(overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: 1,
    status: 'success',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 1,
    currentPr: 7,
    runId: 'run-abc',
    provider: 'openrouter',
    model: 'test/model-x',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:05.000Z',
    options: {
      autoMerge: false,
      prPerTask: false,
      maxPrs: 1,
      maxSessions: 3,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
    usage: {
      perRole: {
        planner: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          calls: 1,
          costUsd: 0.001,
          cacheDiscountUsd: null,
        },
        worker: {
          inputTokens: 400,
          outputTokens: 90,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          calls: 3,
          costUsd: 0.004,
          cacheDiscountUsd: null,
        },
      },
      overall: {
        inputTokens: 500,
        outputTokens: 110,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 0,
        calls: 4,
        costUsd: 0.005,
        cacheDiscountUsd: null,
      },
    },
    ...overrides,
  };
}

test('buildBenchRow: derives outcome, duration, per-role tokens and cost from persisted state', () => {
  const row = buildBenchRow({
    scenario: 'single-file',
    outcome: 'pass',
    state: fixtureState(),
    repo: 'acme/aitm-bench-single-file-x',
  });
  assert.equal(row.scenario, 'single-file');
  assert.equal(row.outcome, 'pass');
  assert.equal(row.status, 'success');
  assert.equal(row.model, 'test/model-x');
  assert.equal(row.durationMs, 5000, 'updatedAt − createdAt');
  assert.equal(row.costUsd, 0.005);
  assert.equal(row.pr, 7);
  assert.equal(row.repo, 'acme/aitm-bench-single-file-x');
  assert.equal(row.tokens.overall.input, 500);
  assert.equal(row.tokens.overall.output, 110);
  assert.equal(row.tokens.perRole.worker?.input, 400);
  assert.equal(row.tokens.perRole.worker?.calls, 3);
  assert.equal(row.tokens.perRole.reviewer, undefined, 'roles that never ran are absent');
});

test('buildBenchRow: a pre-#114 state without usage degrades to zero tokens + null cost, not a throw', () => {
  const row = buildBenchRow({
    scenario: 'single-file',
    outcome: 'fail',
    state: fixtureState({ usage: undefined }),
    repo: 'acme/r',
  });
  assert.equal(row.costUsd, null);
  assert.deepEqual(row.tokens.overall, { input: 0, output: 0, cached: 0, calls: 0 });
  assert.deepEqual(row.tokens.perRole, {});
  assert.equal(row.outcome, 'fail');
});

test('buildBenchRow: a negative clock skew (updatedAt before createdAt) floors duration at 0', () => {
  const row = buildBenchRow({
    scenario: 'x',
    outcome: 'pass',
    state: fixtureState({
      createdAt: '2026-01-01T00:00:05.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    repo: 'r',
  });
  assert.equal(row.durationMs, 0);
});

test('toJsonl / parseJsonl: round-trips a row, skips blank lines, and reports a bad line number', () => {
  const row = buildBenchRow({
    scenario: 'x',
    outcome: 'pass',
    state: fixtureState(),
    repo: 'acme/r',
  });
  const line = toJsonl(row);
  assert.ok(!line.includes('\n'), 'one row is one line');
  const parsed = parseJsonl(`\n${line}\n\n${line}\n`);
  assert.equal(parsed.length, 2, 'blank lines skipped');
  assert.deepEqual(parsed[0], row);
  assert.throws(() => parseJsonl('{"ok":1}\nnot json\n'), /line 2 is not valid JSON/);
});

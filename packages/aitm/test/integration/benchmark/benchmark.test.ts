// Benchmark harness tests (issue #184). Two layers:
//   - PURE (always run, no secrets): row-shaping from a persisted state fixture, JSONL round-trip, and
//     the compare/diff table. These are what the gates actually verify.
//   - LIVE (gated on OPENROUTER_API_KEY + AITM_SANDBOX_REPO): each graded scenario runs against a real
//     sandbox repo and must emit one fully-populated row. Skips cleanly in CI without secrets.
//
// Lives under test/integration so `test:integration` runs it; the pure layer executes there un-gated.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunState } from '../../../src/state/schema.ts';
import { compareLedgers, renderComparison } from './bench-compare.ts';
import { buildBenchRow, parseJsonl, toJsonl } from './bench-row.ts';
import { readBenchConfig, runScenario } from './bench-runner.ts';
import { BENCH_SCENARIOS } from './scenarios.ts';

function fixtureState(overrides: Partial<RunState> = {}): RunState {
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

// ---- PURE: row shaping -----------------------------------------------------

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

// ---- PURE: compare ---------------------------------------------------------

test('compareLedgers: per-scenario deltas (B−A), verdict flips, and one-sided scenarios', () => {
  const a = [
    buildBenchRow({ scenario: 's1', outcome: 'pass', state: fixtureState(), repo: 'r' }),
    buildBenchRow({ scenario: 's2', outcome: 'pass', state: fixtureState(), repo: 'r' }),
  ];
  const b = [
    // s1 same verdict, cheaper (half the cost, fewer tokens); s2 flipped to fail; s3 only in B.
    buildBenchRow({
      scenario: 's1',
      outcome: 'pass',
      state: fixtureState({
        usage: {
          perRole: {},
          overall: {
            inputTokens: 250,
            outputTokens: 55,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            calls: 2,
            costUsd: 0.0025,
            cacheDiscountUsd: null,
          },
        },
      }),
      repo: 'r',
    }),
    buildBenchRow({ scenario: 's2', outcome: 'fail', state: fixtureState(), repo: 'r' }),
    buildBenchRow({ scenario: 's3', outcome: 'pass', state: fixtureState(), repo: 'r' }),
  ];
  const cmp = compareLedgers(a, b);
  const byId = Object.fromEntries(cmp.map((c) => [c.scenario, c]));

  assert.equal(byId.s1?.flipped, false, 's1 verdict unchanged');
  assert.equal(byId.s1?.tokensDelta, 250 + 55 - (500 + 110), 's1 fewer tokens (negative)');
  assert.ok((byId.s1?.costDelta ?? 0) < 0, 's1 cheaper in B');

  assert.equal(byId.s2?.flipped, true, 's2 pass→fail is a flip');

  assert.equal(byId.s3?.aOutcome, null, 's3 absent from A');
  assert.equal(byId.s3?.flipped, false, 'a one-sided scenario is not a flip');
  assert.equal(byId.s3?.tokensDelta, null, 'no delta without both sides');
});

test('compareLedgers: an append-only ledger uses the LAST run per scenario', () => {
  const older = buildBenchRow({
    scenario: 's1',
    outcome: 'fail',
    state: fixtureState(),
    repo: 'r',
  });
  const newer = buildBenchRow({
    scenario: 's1',
    outcome: 'pass',
    state: fixtureState(),
    repo: 'r',
  });
  const cmp = compareLedgers([older, newer], [newer]);
  assert.equal(cmp.length, 1);
  assert.equal(cmp[0]?.aOutcome, 'pass', 'the later row (pass) wins over the earlier (fail)');
});

test('renderComparison: a readable table with a flip marker and a flip-count summary', () => {
  const a = [buildBenchRow({ scenario: 's2', outcome: 'pass', state: fixtureState(), repo: 'r' })];
  const b = [buildBenchRow({ scenario: 's2', outcome: 'fail', state: fixtureState(), repo: 'r' })];
  const out = renderComparison(compareLedgers(a, b), { a: 'glm', b: 'k3' });
  assert.match(out, /scenario/, 'has a header');
  assert.match(out, /glm/);
  assert.match(out, /k3/);
  assert.match(out, /s2/);
  assert.match(out, /flip/, 'marks the verdict flip');
  assert.match(out, /1 outcome flip\(s\)/, 'summary counts the flip');
});

// ---- LIVE: gated scenario runs ---------------------------------------------

const cfg = readBenchConfig(process.env);

for (const scenario of BENCH_SCENARIOS) {
  test(`benchmark scenario "${scenario.id}" (grade ${scenario.grade}): runs and emits a full row`, {
    skip: cfg ? false : 'set OPENROUTER_API_KEY + AITM_SANDBOX_REPO to run the live benchmark',
    timeout: 900_000,
  }, async () => {
    if (!cfg) return;
    const row = await runScenario(cfg, scenario, (s) => console.log(`[bench] ${s}`));
    assert.equal(row.scenario, scenario.id);
    assert.ok(row.model.length > 0, 'model recorded');
    assert.ok(row.durationMs >= 0, 'duration recorded');
    assert.ok(row.repo.includes('/'), 'kept sandbox repo slug recorded');
    assert.ok(row.outcome === 'pass' || row.outcome === 'fail', 'a verdict was reached');
    assert.ok(row.tokens.overall.calls >= 0, 'usage totals present');
  });
}

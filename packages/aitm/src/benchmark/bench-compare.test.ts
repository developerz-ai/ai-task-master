// Pure tests for the benchmark compare engine (issue #184): diff two ledgers by scenario, render the
// delta table. Builds BenchRow objects directly (the row shape is public) so these stay decoupled from
// the state→row mapping tested in bench-row.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareLedgers, renderComparison } from './bench-compare.ts';
import type { BenchRow } from './bench-row.ts';

function row(overrides: Partial<BenchRow> = {}): BenchRow {
  return {
    scenario: 's',
    outcome: 'pass',
    status: 'success',
    model: 'm',
    durationMs: 1000,
    costUsd: 0.005,
    costEstimated: false,
    tokens: { overall: { input: 500, output: 110, cached: 0, calls: 4 }, perRole: {} },
    repo: 'acme/r',
    pr: 1,
    runId: 'x',
    at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('compareLedgers: per-scenario deltas (B−A), verdict flips, and one-sided scenarios', () => {
  const a = [row({ scenario: 's1' }), row({ scenario: 's2' })];
  const b = [
    // s1 same verdict, cheaper + fewer tokens; s2 flipped to fail; s3 only in B.
    row({
      scenario: 's1',
      costUsd: 0.0025,
      tokens: { overall: { input: 250, output: 55, cached: 0, calls: 2 }, perRole: {} },
    }),
    row({ scenario: 's2', outcome: 'fail' }),
    row({ scenario: 's3' }),
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

test('compareLedgers: a null cost on either side yields a null cost delta (not NaN)', () => {
  const cmp = compareLedgers([row({ scenario: 's', costUsd: null })], [row({ scenario: 's' })]);
  assert.equal(cmp[0]?.costDelta, null);
});

test('compareLedgers: an append-only ledger uses the LAST run per scenario', () => {
  const older = row({ scenario: 's1', outcome: 'fail' });
  const newer = row({ scenario: 's1', outcome: 'pass' });
  const cmp = compareLedgers([older, newer], [newer]);
  assert.equal(cmp.length, 1);
  assert.equal(cmp[0]?.aOutcome, 'pass', 'the later row (pass) wins over the earlier (fail)');
});

test('compareLedgers: scenarios are sorted so the table is stable across runs', () => {
  const cmp = compareLedgers([row({ scenario: 'z' }), row({ scenario: 'a' })], []);
  assert.deepEqual(
    cmp.map((c) => c.scenario),
    ['a', 'z'],
  );
});

test('renderComparison: a readable table with a flip marker and a flip-count summary', () => {
  const a = [row({ scenario: 's2', outcome: 'pass' })];
  const b = [row({ scenario: 's2', outcome: 'fail' })];
  const out = renderComparison(compareLedgers(a, b), { a: 'glm', b: 'k3' });
  assert.match(out, /scenario/, 'has a header');
  assert.match(out, /glm/);
  assert.match(out, /k3/);
  assert.match(out, /s2/);
  assert.match(out, /flip/, 'marks the verdict flip');
  assert.match(out, /1 outcome flip\(s\)/, 'summary counts the flip');
});

// The `compare` command's engine (issue #184): diff two benchmark ledgers by scenario and render a
// readable delta table. Pure — takes two already-parsed row arrays and returns a string — so it is
// unit-tested without touching disk. The script wrapper (scripts/benchmark.ts) reads the two files and
// prints what this returns.
//
// Semantics: a ledger is append-only and may hold several runs of the same scenario; the comparison
// uses the LAST row per scenario in each file (the most recent run). "A" is the baseline (first file),
// "B" the candidate (second file); deltas are B−A, so a negative token/cost/duration delta means B is
// cheaper/faster.

import type { BenchRow } from './bench-row.ts';

export type ScenarioComparison = {
  scenario: string;
  aOutcome: 'pass' | 'fail' | null;
  bOutcome: 'pass' | 'fail' | null;
  // The signal a model comparison cares about most: did the pass/fail verdict change between A and B.
  flipped: boolean;
  aTokens: number | null;
  bTokens: number | null;
  tokensDelta: number | null;
  aCost: number | null;
  bCost: number | null;
  costDelta: number | null;
  aMs: number | null;
  bMs: number | null;
  msDelta: number | null;
};

function totalTokens(row: BenchRow): number {
  return row.tokens.overall.input + row.tokens.overall.output;
}

// Last row per scenario (append-only ledgers keep history; the newest run wins).
function lastPerScenario(rows: readonly BenchRow[]): Map<string, BenchRow> {
  const m = new Map<string, BenchRow>();
  for (const row of rows) m.set(row.scenario, row);
  return m;
}

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

// Compare two ledgers, one ScenarioComparison per scenario present in EITHER file, sorted by scenario
// id so the table is stable across runs. A scenario missing from one side yields nulls on that side
// (and flipped=false — an absence is not a verdict flip).
export function compareLedgers(
  aRows: readonly BenchRow[],
  bRows: readonly BenchRow[],
): ScenarioComparison[] {
  const a = lastPerScenario(aRows);
  const b = lastPerScenario(bRows);
  const scenarios = [...new Set([...a.keys(), ...b.keys()])].sort();
  return scenarios.map((scenario) => {
    const ra = a.get(scenario) ?? null;
    const rb = b.get(scenario) ?? null;
    const aOutcome = ra?.outcome ?? null;
    const bOutcome = rb?.outcome ?? null;
    const aTokens = ra ? totalTokens(ra) : null;
    const bTokens = rb ? totalTokens(rb) : null;
    return {
      scenario,
      aOutcome,
      bOutcome,
      flipped: aOutcome !== null && bOutcome !== null && aOutcome !== bOutcome,
      aTokens,
      bTokens,
      tokensDelta: delta(aTokens, bTokens),
      aCost: ra?.costUsd ?? null,
      bCost: rb?.costUsd ?? null,
      costDelta: delta(ra?.costUsd ?? null, rb?.costUsd ?? null),
      aMs: ra?.durationMs ?? null,
      bMs: rb?.durationMs ?? null,
      msDelta: delta(ra?.durationMs ?? null, rb?.durationMs ?? null),
    };
  });
}

function cell(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function fmtOutcome(o: 'pass' | 'fail' | null): string {
  return o === null ? '—' : o;
}

function fmtSignedInt(n: number | null): string {
  if (n === null) return '—';
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `${r}`;
}

function fmtSignedCost(n: number | null): string {
  if (n === null) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(4);
}

// Render the comparison as a fixed-width text table. `labels` names the two ledgers in the header
// (defaults A/B). A trailing summary counts verdict flips — the headline a model swap is judged on.
export function renderComparison(
  comparisons: readonly ScenarioComparison[],
  labels: { a: string; b: string } = { a: 'A', b: 'B' },
): string {
  const header = [
    cell('scenario', 22),
    cell(labels.a, 6),
    cell(labels.b, 6),
    cell('Δtokens', 10),
    cell('Δcost', 10),
    cell('Δms', 10),
  ].join('  ');
  const rows = comparisons.map((c) => {
    const flip = c.flipped ? '  ⚠ flip' : '';
    return (
      [
        cell(c.scenario, 22),
        cell(fmtOutcome(c.aOutcome), 6),
        cell(fmtOutcome(c.bOutcome), 6),
        cell(fmtSignedInt(c.tokensDelta), 10),
        cell(fmtSignedCost(c.costDelta), 10),
        cell(fmtSignedInt(c.msDelta), 10),
      ].join('  ') + flip
    );
  });
  const flips = comparisons.filter((c) => c.flipped).length;
  const summary = `\n${comparisons.length} scenario(s), ${flips} outcome flip(s) (${labels.a} → ${labels.b})`;
  return [header, ...rows].join('\n') + summary;
}

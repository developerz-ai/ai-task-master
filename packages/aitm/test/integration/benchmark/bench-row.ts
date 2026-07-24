// The benchmark ledger row (issue #184). One JSON object per graded scenario run, derived PURELY
// from the run's persisted state.json (issue #114 usage totals) plus the scenario's pass/fail verdict
// and the sandbox repo it ran against. No clock, no env, no I/O — so a row is a deterministic function
// of its inputs and the JSONL it produces is snapshot-testable. The live runner (bench-runner.ts) is
// the only impure caller; the compare command (bench-compare.ts) reads the rows back.

import type { Role } from '../../../src/credentials/credentials.ts';
import type { RunState, RunStatus } from '../../../src/state/schema.ts';

// Per-role (and overall) token counts flattened to the four figures a model comparison actually reads.
// Costs live on the row (overall only) since per-role pricing rarely drives a model choice.
export type BenchTokens = {
  input: number;
  output: number;
  cached: number;
  calls: number;
};

// One benchmark run. `outcome` is the scenario's own verdict (did the produced code satisfy the goal);
// `status` is the loop's self-reported terminal state — the two can disagree (a run can report success
// yet produce code that fails the scenario's check, which is exactly the signal a model comparison wants).
export type BenchRow = {
  scenario: string;
  outcome: 'pass' | 'fail';
  status: RunStatus;
  model: string;
  durationMs: number;
  costUsd: number | null;
  costEstimated: boolean;
  tokens: { overall: BenchTokens; perRole: Partial<Record<Role, BenchTokens>> };
  // The sandbox repo + PR are KEPT after the run (never deleted) so the produced code can be reviewed
  // later; the row records where to find them.
  repo: string;
  pr: number | null;
  runId: string;
  // The run's own updatedAt (persisted, not a fresh clock read) so the row stays deterministic.
  at: string;
};

const ROLES: readonly Role[] = ['planner', 'worker', 'reviewer', 'orchestrator'];

function flatten(u: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  calls: number;
}): BenchTokens {
  return {
    input: u.inputTokens,
    output: u.outputTokens,
    cached: u.cachedInputTokens,
    calls: u.calls,
  };
}

// Build a row from a finished run's persisted state. durationMs is updatedAt−createdAt (both ISO in
// state.json); a state that predates issue #114 carries no `usage`, so tokens/cost degrade to zeros/null
// rather than throwing — the row still records outcome, model, and duration.
export function buildBenchRow(input: {
  scenario: string;
  outcome: 'pass' | 'fail';
  state: RunState;
  repo: string;
  costEstimated?: boolean;
}): BenchRow {
  const { scenario, outcome, state, repo } = input;
  const usage = state.usage;
  const perRole: Partial<Record<Role, BenchTokens>> = {};
  if (usage) {
    for (const role of ROLES) {
      const ru = usage.perRole[role];
      if (ru) perRole[role] = flatten(ru);
    }
  }
  const overall = usage ? flatten(usage.overall) : { input: 0, output: 0, cached: 0, calls: 0 };
  const durationMs = Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt));
  return {
    scenario,
    outcome,
    status: state.status,
    model: state.model,
    durationMs,
    costUsd: usage ? usage.overall.costUsd : null,
    costEstimated: input.costEstimated ?? false,
    tokens: { overall, perRole },
    repo,
    pr: state.currentPr,
    runId: state.runId,
    at: state.updatedAt,
  };
}

// Serialize one row as a single JSONL line (no trailing newline — the writer joins with '\n'). Stable
// key order via JSON.stringify on the constructed object, so two identical rows serialize byte-identically.
export function toJsonl(row: BenchRow): string {
  return JSON.stringify(row);
}

// Parse an append-only JSONL file's contents into rows, skipping blank lines. A malformed line throws
// with its 1-based number so a truncated ledger is a clear error, not a silent drop.
export function parseJsonl(contents: string): BenchRow[] {
  const rows: BenchRow[] = [];
  const lines = contents.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line) as BenchRow);
    } catch (err) {
      throw new Error(
        `benchmark ledger line ${i + 1} is not valid JSON: ${(err as Error).message}`,
      );
    }
  }
  return rows;
}

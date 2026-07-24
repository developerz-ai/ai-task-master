#!/usr/bin/env -S node --import tsx
// Local runner for the graded benchmark harness (issue #184) — the operator counterpart to
// test/integration/benchmark/. Two subcommands:
//
//   Run scenarios and append one JSONL row each to a ledger (keeps every sandbox repo for review):
//     OPENROUTER_API_KEY=… AITM_SANDBOX_REPO=<owner> AITM_BENCH_MODEL=<model> \
//       bun scripts/benchmark.ts run [--scenario <id>] [--out <ledger.jsonl>]
//
//   Compare two ledgers (e.g. one model vs another) by scenario — verdict flips + token/cost/ms deltas:
//     bun scripts/benchmark.ts compare <baseline.jsonl> <candidate.jsonl> [--labels <a>,<b>]
//
// The shebang runs the .ts entrypoint via `node --import tsx` so `./benchmark.ts` works on plain Node;
// `bun scripts/benchmark.ts` runs it directly. Uses a FREE OpenRouter model by default so a bare run
// never spends. Sandbox repos are KEPT (never deleted): the produced code is the artifact a model
// comparison reviews by hand.

import { appendFile, readFile } from 'node:fs/promises';
import { compareLedgers, renderComparison } from '../test/integration/benchmark/bench-compare.ts';
import { parseJsonl, toJsonl } from '../test/integration/benchmark/bench-row.ts';
import { readBenchConfig, runScenario } from '../test/integration/benchmark/bench-runner.ts';
import { BENCH_SCENARIOS, scenarioById } from '../test/integration/benchmark/scenarios.ts';

// Thrown on a malformed invocation so the top-level dispatcher can turn it into a clean message + the
// documented validation exit code (2) rather than an unhandled stack trace.
class UsageError extends Error {}

// A flag's value. Present-without-a-value — the flag is last, or the next token is itself a flag — is a
// UsageError, never a silent default: for a live runner that spends, `run --scenario` silently running
// EVERY scenario (or `--out` silently writing the default ledger) could launch unintended sandboxes.
function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${name} requires a value`);
  }
  return value;
}

async function runCmd(args: string[]): Promise<number> {
  const cfg = readBenchConfig(process.env);
  if (!cfg) {
    console.error(
      'benchmark: set OPENROUTER_API_KEY and AITM_SANDBOX_REPO (a GitHub owner/org) to run.',
    );
    return 2;
  }
  const only = flagValue(args, '--scenario');
  const out = flagValue(args, '--out') ?? 'aitm-bench.jsonl';
  const scenarios = only
    ? [scenarioById(only)].filter((s): s is NonNullable<typeof s> => s !== undefined)
    : [...BENCH_SCENARIOS];
  if (only && scenarios.length === 0) {
    console.error(
      `benchmark: unknown scenario "${only}". Known: ${BENCH_SCENARIOS.map((s) => s.id).join(', ')}`,
    );
    return 2;
  }

  // Preflight the ledger: a write failure must stop the run BEFORE any sandbox/PR is created (and spend
  // incurred). Afterwards a per-row append failure is FATAL too — a dropped row would silently break the
  // append-only contract while later scenarios kept running.
  try {
    await appendFile(out, '');
  } catch (err) {
    console.error(
      `benchmark: ledger ${out} is not writable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  console.log(
    `benchmark: model=${cfg.model} scenarios=${scenarios.map((s) => s.id).join(',')} → ${out}`,
  );
  let failures = 0;
  for (const scenario of scenarios) {
    let row: Awaited<ReturnType<typeof runScenario>>;
    try {
      row = await runScenario(cfg, scenario, (s) => console.log(`[bench] ${s}`));
    } catch (err) {
      // A scenario's own infra failure (start crashed, gh error) is not fatal — record nothing for it
      // and move on. A ledger WRITE failure below is a different class and does stop the run.
      failures++;
      console.error(
        `  ❌ ${scenario.id}: infra error — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    await appendFile(out, `${toJsonl(row)}\n`); // fatal on error: propagates to the dispatcher
    const cost = row.costUsd === null ? 'n/a' : `$${row.costUsd.toFixed(4)}`;
    console.log(
      `  ${row.outcome === 'pass' ? '✅' : '❌'} ${scenario.id}: ${row.outcome} · ` +
        `${row.tokens.overall.input + row.tokens.overall.output} tok · ${cost} · ${row.durationMs}ms · ${row.repo}`,
    );
    if (row.outcome !== 'pass') failures++;
  }
  console.log(`\nrows appended to ${out}. ${failures} scenario(s) did not pass.`);
  return failures === 0 ? 0 : 1;
}

async function compareCmd(args: string[]): Promise<number> {
  const labelArg = flagValue(args, '--labels');
  // Positionals exclude flags AND a flag's value (the token right after --labels), so the two ledger
  // paths are found regardless of whether --labels comes before or after them.
  const positional = args.filter((a, idx) => !a.startsWith('--') && args[idx - 1] !== '--labels');
  const [aPath, bPath] = positional;
  if (!aPath || !bPath) {
    console.error(
      'benchmark compare: need two ledger files: compare <baseline.jsonl> <candidate.jsonl>',
    );
    return 2;
  }
  const [aLabel, bLabel] = labelArg ? labelArg.split(',') : [];
  let aRows: ReturnType<typeof parseJsonl>;
  let bRows: ReturnType<typeof parseJsonl>;
  try {
    aRows = parseJsonl(await readFile(aPath, 'utf8'));
    bRows = parseJsonl(await readFile(bPath, 'utf8'));
  } catch (err) {
    console.error(`benchmark compare: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  console.log(
    renderComparison(compareLedgers(aRows, bRows), { a: aLabel || aPath, b: bLabel || bPath }),
  );
  return 0;
}

const [sub, ...rest] = process.argv.slice(2);
let code: number;
try {
  if (sub === 'run') code = await runCmd(rest);
  else if (sub === 'compare') code = await compareCmd(rest);
  else {
    console.error(
      'usage: benchmark.ts <run|compare> [...]\n  run     [--scenario <id>] [--out <ledger.jsonl>]\n  compare <a.jsonl> <b.jsonl> [--labels <a>,<b>]',
    );
    code = 2;
  }
} catch (err) {
  // UsageError (missing flag value) and any other synchronous dispatch error → clean message + code 2.
  console.error(`benchmark: ${err instanceof Error ? err.message : String(err)}`);
  code = 2;
}
process.exit(code);

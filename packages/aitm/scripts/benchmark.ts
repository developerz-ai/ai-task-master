#!/usr/bin/env node
// Local runner for the graded benchmark harness (issue #184) — the operator counterpart to
// test/integration/benchmark/benchmark.test.ts. Two subcommands:
//
//   Run scenarios and append one JSONL row each to a ledger (keeps every sandbox repo for review):
//     OPENROUTER_API_KEY=… AITM_SANDBOX_REPO=<owner> AITM_BENCH_MODEL=<model> \
//       bun scripts/benchmark.ts run [--scenario <id>] [--out <ledger.jsonl>]
//
//   Compare two ledgers (e.g. one model vs another) by scenario — verdict flips + token/cost/ms deltas:
//     bun scripts/benchmark.ts compare <baseline.jsonl> <candidate.jsonl> [--labels <a>,<b>]
//
// Uses a FREE OpenRouter model by default so a bare run never spends. Sandbox repos are KEPT (never
// deleted): the produced code is the artifact a model comparison reviews by hand.

import { appendFile, readFile } from 'node:fs/promises';
import { compareLedgers, renderComparison } from '../test/integration/benchmark/bench-compare.ts';
import { parseJsonl, toJsonl } from '../test/integration/benchmark/bench-row.ts';
import { readBenchConfig, runScenario } from '../test/integration/benchmark/bench-runner.ts';
import { BENCH_SCENARIOS, scenarioById } from '../test/integration/benchmark/scenarios.ts';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function runCmd(args: string[]): Promise<number> {
  const cfg = readBenchConfig(process.env);
  if (!cfg) {
    console.error(
      'benchmark: set OPENROUTER_API_KEY and AITM_SANDBOX_REPO (a GitHub owner/org) to run.',
    );
    return 2;
  }
  const only = flag(args, '--scenario');
  const out = flag(args, '--out') ?? 'aitm-bench.jsonl';
  const scenarios = only
    ? [scenarioById(only)].filter((s): s is NonNullable<typeof s> => s !== undefined)
    : [...BENCH_SCENARIOS];
  if (only && scenarios.length === 0) {
    console.error(
      `benchmark: unknown scenario "${only}". Known: ${BENCH_SCENARIOS.map((s) => s.id).join(', ')}`,
    );
    return 2;
  }
  console.log(
    `benchmark: model=${cfg.model} scenarios=${scenarios.map((s) => s.id).join(',')} → ${out}`,
  );
  let failures = 0;
  for (const scenario of scenarios) {
    try {
      const row = await runScenario(cfg, scenario, (s) => console.log(`[bench] ${s}`));
      await appendFile(out, `${toJsonl(row)}\n`);
      const cost = row.costUsd === null ? 'n/a' : `$${row.costUsd.toFixed(4)}`;
      console.log(
        `  ${row.outcome === 'pass' ? '✅' : '❌'} ${scenario.id}: ${row.outcome} · ` +
          `${row.tokens.overall.input + row.tokens.overall.output} tok · ${cost} · ${row.durationMs}ms · ${row.repo}`,
      );
      if (row.outcome !== 'pass') failures++;
    } catch (err) {
      failures++;
      console.error(
        `  ❌ ${scenario.id}: infra error — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(`\nrows appended to ${out}. ${failures} scenario(s) did not pass.`);
  return failures === 0 ? 0 : 1;
}

async function compareCmd(args: string[]): Promise<number> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const [aPath, bPath] = positional;
  if (!aPath || !bPath) {
    console.error(
      'benchmark compare: need two ledger files: compare <baseline.jsonl> <candidate.jsonl>',
    );
    return 2;
  }
  const labelArg = flag(args, '--labels');
  const [aLabel, bLabel] = labelArg ? labelArg.split(',') : [];
  const aRows = parseJsonl(await readFile(aPath, 'utf8'));
  const bRows = parseJsonl(await readFile(bPath, 'utf8'));
  console.log(
    renderComparison(compareLedgers(aRows, bRows), { a: aLabel || aPath, b: bLabel || bPath }),
  );
  return 0;
}

const [sub, ...rest] = process.argv.slice(2);
let code: number;
if (sub === 'run') code = await runCmd(rest);
else if (sub === 'compare') code = await compareCmd(rest);
else {
  console.error(
    'usage: benchmark.ts <run|compare> [...]\n  run     [--scenario <id>] [--out <ledger.jsonl>]\n  compare <a.jsonl> <b.jsonl> [--labels <a>,<b>]',
  );
  code = 2;
}
process.exit(code);

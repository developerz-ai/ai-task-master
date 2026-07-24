// Tests for the live benchmark runner (issue #184). readBenchConfig is pure (env → config or null, the
// logic that decides whether live runs execute at all) and always runs. The scenario runs are LIVE —
// real gh/git/OpenRouter against a sandbox — and gate on OPENROUTER_API_KEY + AITM_SANDBOX_REPO, so CI
// without secrets skips them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BENCH_SCENARIOS } from '../../../src/benchmark/scenarios.ts';
import { readBenchConfig, runScenario } from './bench-runner.ts';

// ---- PURE: readBenchConfig (the live-run gate) -----------------------------

test('readBenchConfig: null unless BOTH the api key and the sandbox owner are set', () => {
  assert.equal(readBenchConfig({}), null);
  assert.equal(readBenchConfig({ OPENROUTER_API_KEY: 'k' }), null, 'no sandbox → null');
  assert.equal(readBenchConfig({ AITM_SANDBOX_REPO: 'acme' }), null, 'no key → null');
  assert.ok(readBenchConfig({ OPENROUTER_API_KEY: 'k', AITM_SANDBOX_REPO: 'acme' }));
});

test('readBenchConfig: extracts the owner from a bare owner or an owner/repo sandbox value', () => {
  const bare = readBenchConfig({ OPENROUTER_API_KEY: 'k', AITM_SANDBOX_REPO: 'acme' });
  assert.equal(bare?.owner, 'acme');
  const scoped = readBenchConfig({ OPENROUTER_API_KEY: 'k', AITM_SANDBOX_REPO: 'acme/whatever' });
  assert.equal(scoped?.owner, 'acme', 'only the owner segment is used');
});

test('readBenchConfig: model precedence is AITM_BENCH_MODEL > AITM_SMOKE_MODEL > free default', () => {
  const base = { OPENROUTER_API_KEY: 'k', AITM_SANDBOX_REPO: 'acme' };
  assert.match(readBenchConfig(base)?.model ?? '', /:free$/, 'defaults to a free model (no spend)');
  assert.equal(readBenchConfig({ ...base, AITM_SMOKE_MODEL: 'smoke/m' })?.model, 'smoke/m');
  assert.equal(
    readBenchConfig({ ...base, AITM_SMOKE_MODEL: 'smoke/m', AITM_BENCH_MODEL: 'bench/m' })?.model,
    'bench/m',
    'AITM_BENCH_MODEL wins',
  );
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
    assert.ok(row.repo.includes('/'), 'kept sandbox repo slug recorded');
    assert.ok(row.outcome === 'pass' || row.outcome === 'fail', 'a verdict was reached');
    // A real live run always records at least one model call and takes nonzero time — a zero here
    // means the persisted usage (issue #114) was missing, so the "full row" would be hollow.
    assert.ok(row.tokens.overall.calls > 0, 'persisted usage records at least one call');
    assert.ok(row.durationMs > 0, 'a real run took nonzero time');
  });
}

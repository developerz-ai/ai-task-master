// End-to-end smoke (issue #19): aitm start → PR → aitm merge-pr → merged, on a REAL sandbox
// GitHub repo. Gated on `OPENROUTER_API_KEY` + `AITM_SANDBOX_REPO` so CI without secrets
// skips cleanly. On failure the sandbox repo is left behind for inspection (cleanup only on
// success). Runs under both `bun test` and `node --test` (node:test API + a 10-min timeout).
//
// A second, streaming:true variant (slice 07) runs the identical flow through the streaming
// funnel — same gate, own sandbox repo. The two fixture-config unit tests below assert the
// flag-off `.aitm.json` fixture stays byte-identical regardless of the streaming variant
// existing, so parity holds even when the gated pair never runs (e.g. CI without secrets).
//
// The flow lives in ./e2e-smoke.ts; this file is the gate + the named test entries.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixtureConfig, readSmokeConfig, runE2ESmoke } from './e2e-smoke.ts';

const cfg = readSmokeConfig(process.env);

test('e2e smoke: aitm start → PR → aitm merge-pr → merged (real sandbox repo)', {
  skip: cfg ? false : 'set OPENROUTER_API_KEY + AITM_SANDBOX_REPO (a sandbox owner) to run',
  // <10 min budget per issue #19; only spent when the gate is open.
  timeout: 600_000,
}, async () => {
  // cfg is non-null here (the test is skipped otherwise); assert for the type-checker.
  if (!cfg) return;
  await runE2ESmoke(cfg, (s) => {
    console.log(`[e2e-smoke] ${s}`);
  });
});

test('e2e smoke (streaming:true): aitm start → PR → aitm merge-pr → merged (real sandbox repo)', {
  skip: cfg ? false : 'set OPENROUTER_API_KEY + AITM_SANDBOX_REPO (a sandbox owner) to run',
  timeout: 600_000,
}, async () => {
  if (!cfg) return;
  await runE2ESmoke({ ...cfg, streaming: true }, (s) => {
    console.log(`[e2e-smoke:streaming] ${s}`);
  });
});

test('e2e-smoke fixture: streaming omitted stays byte-identical to the pre-streaming .aitm.json', () => {
  assert.deepEqual(buildFixtureConfig('some/model'), {
    models: {
      generic: 'some/model',
      smart: 'some/model',
      coding: 'some/model',
      fast: 'some/model',
    },
  });
});

test('e2e-smoke fixture: streaming:true adds the flag only, rest identical to flag-off', () => {
  const off = buildFixtureConfig('some/model');
  const on = buildFixtureConfig('some/model', true);
  assert.deepEqual(on, { ...off, streaming: true });
  assert.deepEqual(
    buildFixtureConfig('some/model', false),
    off,
    'streaming:false parity with omitted',
  );
});

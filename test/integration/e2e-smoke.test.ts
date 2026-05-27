// End-to-end smoke (issue #19): aitm start → PR → aitm merge-pr → merged, on a REAL sandbox
// GitHub repo. Gated on `OPENROUTER_API_KEY` + `AITM_SANDBOX_REPO` so CI without secrets
// skips cleanly. On failure the sandbox repo is left behind for inspection (cleanup only on
// success). Runs under both `bun test` and `node --test` (node:test API + a 10-min timeout).
//
// The flow lives in ./e2e-smoke.ts; this file is the gate + the named test entry.

import { test } from 'node:test';
import { readSmokeConfig, runE2ESmoke } from './e2e-smoke.ts';

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

#!/usr/bin/env bun
// Local runner for the end-to-end smoke (issue #19) — the script counterpart to
// test/integration/e2e-smoke.test.ts. Same flow, runnable by hand:
//
//   OPENROUTER_API_KEY=… AITM_SANDBOX_REPO=<owner> bun scripts/smoke-e2e.ts
//
// Creates a fresh repo under <owner>, runs aitm start → merge-pr → asserts FOO landed on the
// default branch, then deletes the repo on success (leaves it on failure). See
// test/integration/e2e-smoke.ts for prerequisites (gh delete_repo scope; MCP worker tools
// for the start half). Uses a FREE OpenRouter model by default (AITM_SMOKE_MODEL overrides).

import { readSmokeConfig, runE2ESmoke } from '../test/integration/e2e-smoke.ts';

const cfg = readSmokeConfig(process.env);
if (!cfg) {
  console.error(
    'smoke-e2e: set OPENROUTER_API_KEY and AITM_SANDBOX_REPO (a GitHub owner/org) to run.',
  );
  process.exit(2);
}

try {
  await runE2ESmoke(cfg, (s) => console.log(`[smoke-e2e] ${s}`));
  console.log('\n✅ e2e smoke passed: start → PR → merge-pr → merged, FOO on default branch.');
  process.exit(0);
} catch (err) {
  console.error(`\n❌ e2e smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error('The sandbox repo was left behind for inspection.');
  process.exit(1);
}

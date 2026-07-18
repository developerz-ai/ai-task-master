# 08 — Tests + gates

> Part of [`overview.md`](overview.md). Depends on: 01–07 (run last; per-slice tests land with their slice — this closes gaps).

## Files to change
- Paired `*.test.ts` beside every touched module (house rule: no test, no merge) — verify each slice actually added them.
- `packages/aitm/test/integration/crash-durability.test.ts`, `resume-flow.test.ts` — extended crash matrix.

## Steps
1. Audit slices 01–07 for the paired-test rule: every changed `src/**/*.ts` has a sibling `*.test.ts` exercising the change (not just existing green).
2. Consolidate the crash matrix in integration tests — kill points: after `gh pr create` / after reviewer reply / after task commit, each before its state persist; resume asserts no duplicate PR/reply/commit and no wrongly-blocked group. Real temp git repo + real `gh` sandbox (no mocking, per house rules).
3. Signal integration: SIGINT mid-run (slice 02) — MCP children reaped, cancelled result surfaced.
4. Full gates both runtimes: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`. No `Bun.*` in shipped code introduced by any slice (grep).
5. Record the slice-06 prompt-size delta (e2e-smoke char counts) in the closing PR.

## Done when
- All gates green on Bun and Node; crash/signal matrix passes; every touched module has paired-test coverage of its fix.

# 11 — Tests, CI & docs closure

> Part of [`overview.md`](overview.md). Depends on: 01-10 (this closes what they didn't cover).
> Findings: test sections of all eight findings files; [`findings/08-architecture-sweep.md`](findings/08-architecture-sweep.md) §4.

## Files to change
- Missing pairs: `src/github/errors.test.ts`, `src/github/schema.test.ts`, `src/credentials/defaults.test.ts` (or amend the CLAUDE.md rule for type/constant-only files — pick one, apply consistently).
- `src/mcp/oauth.test.ts` — full rewrite (slice 04 owns it; verify done).
- `src/testing/temp-repo.ts:19` — `git init -b main` (env-independent branch name).
- `src/index.test.ts:5-23` — assert the exact public surface (presence AND absence) so drift fails.
- `.github/workflows/ci.yml:39-44` + CLAUDE.md — reconcile the "tests pass under both `bun test` and `node --test`, enforced by CI" claim with reality (Bun job skips tests due to oven-sh/bun#5090): either restore a scoped `bun test` job or amend the claim.

## Coverage gaps to close (if their slice didn't)
- Two-store lock contention; `waitForChecks` transient failure + no-checks grace (slice 01/06).
- `take-over-flow` no-changes; prPerTask adminMerge (slice 05).
- Worker outer-abort signal wiring; scout runner real wiring (slice 03/07).
- `error-reporter` DSN-present branch (`beforeSend` registration).
- Compaction overflow + circular-message regressions (slice 08).
- `runMcpLogin` through an injectable `performOAuth` seam (slice 04/09).
- Failure-path cleanup tests from findings/07: `openBrowser` spawn error, partial `connectAll` leak, oauth stop under keep-alive, undici agent teardown.

## Steps
1. Sweep each landed slice's "Tests" section against what actually merged; write the misses.
2. Add the three trivial missing pairs (or the documented rule amendment).
3. Fix temp-repo branch pinning; tighten index surface test.
4. Resolve the CI/CLAUDE.md testing claim.

## Done when
- Every shipped `.ts` under `src/` has a paired test (or the rule explicitly exempts type/constant-only files); CI configuration and CLAUDE.md tell the same story; all coverage gaps listed above have a named test.

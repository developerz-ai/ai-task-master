# 05 — Tests

> Part of [`overview.md`](overview.md). Depends on: 01–04 (each slice ships its own tests; this is the cross-cutting bar + integration coverage).

House rule: **no test, no merge.** Every new module has a paired `*.test.ts`; tests pass under both `bun test` and `node --test` (`bun run test:node`). Integration tests run a real temp git repo with a stubbed `gh` and `MockLanguageModelV3` — no real network, no real GitHub.

## Files to change / add
- Paired units (created in their slices, listed here for the gate):
  - `src/agent-config/coding-style.test.ts` (01)
  - `src/plan/plan-markdown.test.ts`, `src/state/schema.test.ts` (02)
  - `src/loop/stage-handlers.test.ts` (03)
  - `src/loop/ci-fix.test.ts`, `src/github/github-client.test.ts` (extend, 04)
  - `src/loop/work-loop.test.ts` (extend, 02+03)
  - `src/state/state-store.test.ts` (extend, 01+02+03)
- Integration:
  - `test/integration/ci-fix-loop.test.ts` — **new** (04): fail-once-then-pass CI → download→fix→re-poll→merge.
  - `test/integration/resume-flow.test.ts` — **extend** (03): resume mid-lifecycle at `waiting-ci`.
  - `test/integration/start-flow.test.ts` — **extend** (02): multi-task group writes `[x]` per task to `plan.md`.

## Steps
1. Reuse `testing/temp-repo.ts` (`makeTempRepo({ withClaudeMd: true })`) and the stubbed-gh pattern from existing integration tests. Script the gh stub to return a failing `gh pr checks` once, then success, to exercise the loop.
2. Stub the model with `MockLanguageModelV3` (`ai/test`) — assert prompts contain the coding-style digest (01) and reference `debugging/` dirs (04); return canned tool-call sequences for manifest/editor/fix.
3. Cover legacy-state coercion (02/03): a `state.json` with `tasks: string[]` and no `stage` loads and runs.
4. Cover failure modes: CI-fix loop hits iteration cap → exit 1; merge conflict → exit 1; cancellation → exit 2.
5. Ensure no Bun-only APIs leak into shipped code (CI runs `test:node`); keep `Bun.*` only in dev/test guarded by `process.versions.bun`.

## Tests (commands)
- `bun test` — full suite (unit + integration).
- `bun run test:node` — Node ≥20 portability.
- `bun run typecheck` — `tsc --noEmit`, strict, no `any`.
- `bun run lint` — Biome.

## Done when
- Every new module has a green paired test under both runners; the `ci-fix-loop` integration test proves fail→fix→green→merge end to end; resume + legacy-coercion + cap/conflict/cancel paths covered. `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint` all pass.

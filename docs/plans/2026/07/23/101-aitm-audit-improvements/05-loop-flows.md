# 05 — Loop flows: start / merge-pr correctness & unification

> Part of [`overview.md`](overview.md). Depends on: none (03 makes the signal work easier but isn't required).
> Findings: [`findings/01-loop.md`](findings/01-loop.md) (all bug + arch items not taken by slice 03/10).

## Files to change
- `packages/aitm/src/loop/take-over-flow.ts` — `:228-236` unhandled `'no-changes'` → up to 30 wasted coding-tier passes (HIGH); `:364-421` hand-rolled CI-fix duplicating `runFixSession` without compaction/memory/usage/guards; `:186-193` once-only review grace; `:197,239-257` no addressed-thread dedup; `:211,228` dead `'cancelled'` branch; `:167-171,312` iteration accounting.
- `packages/aitm/src/loop/ci-fix.ts:179` — `prContext.clear(pr)` wipes `addressed_threads.json` (loop-termination dedup); clear only `ci/`/`comments/` subdirs. Also `:383,391` stale rebase stderr; `:378-381` unchecked `git rebase --abort`.
- `packages/aitm/src/loop/self-review.ts:162-177` — Worker `'error'` masked as `{ kind: 'clean' }`; surface as own outcome.
- `packages/aitm/src/loop/run-loop-adapter.ts:1140-1183` — `discoverSpecialists` outside try + floating `.then()` → poisoned memoized promise blocks all later workers; `:1539` plain push where siblings use `--force-with-lease`; `:693` `PlanGraph.validate` throw → graceful blocked.
- `packages/aitm/src/loop/work-loop.ts:1096-1105` vs `stage-handlers.ts:158` — prPerTask ignores `adminMerge` + `maxCiFixAttempts`; route both modes through one policy.
- `packages/aitm/src/loop/stage-handlers.ts:155` — grace sleep on every waiting-ci pass; add once-guard.
- `packages/aitm/src/loop/merge-flow-adapter.ts:30` — merge-pr subagents skip `bashRules`, ProcessManager, `applyHooks` (issues #113/#121); also no usage/budget seam (#190).

## Steps
1. Add the `'no-changes'` guard to take-over's CI-fix result handling (mirror `ci-fix.ts:194-201`); regression test first — `take-over-flow.test.ts` has zero coverage of this kind.
2. Scope `prContext.clear`: new `clearCi(pr)`/`clearComments(pr)`; keep `addressed_threads.json`.
3. Self-review: return `'error'` outcome distinct from `'clean'`; caller treats as unclean/blocked.
4. Wrap specialist discovery in try/catch with `.catch` on the announce; a discovery failure degrades to empty roster, never poisons the run.
5. Unify CI policy: extract one `ciOutcomePolicy` used by stage machine and prPerTask (`adminMerge` timeout override + `maxCiFixAttempts` cap).
6. Unify take-over pipeline: replace `take-over-flow.ts:364-421` with `runFixSession`; add `freshThreads`-style dedup + re-arm review grace after each push; fix iteration accounting; type ci status as `CiState`, handle `'pending'`.
7. merge-flow parity: pass `bashRules`, ProcessManager, `applyHooks`, and an `onUsage`/budget seam through `merge-flow-adapter` + `TakeOverSubagents`.
8. Small fixes: `--force-with-lease` on `openPr` push; graceful blocked on `PlanGraph.validate` throw; fresh stderr in second-attempt rebase abort; check `rebase --abort` exit code.

## Tests
- `take-over-flow.test.ts`: no-changes guard, thread dedup, pending status, grace re-arm, iteration counts.
- `work-loop.test.ts`: adminMerge + fix-attempt cap on prPerTask path.
- `merge-flow-adapter.test.ts`: bashRules/hooks/usage plumbing asserted.
- `ci-fix.test.ts` / `pr-context-store.test.ts`: clear scoping.

## Done when
- `aitm merge-pr` and `aitm start` share one CI-fix pipeline, one thread-dedup, one merge policy; no path can burn 30 no-op LLM passes; an errored review can't masquerade as clean.

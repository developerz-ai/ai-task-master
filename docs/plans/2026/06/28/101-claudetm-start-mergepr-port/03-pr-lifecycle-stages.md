# 03 — PR-lifecycle stage machine

> Part of [`overview.md`](overview.md). Depends on: 02 (per-group/per-task execution).

Claudetm persists a `workflow_stage` so a crashed/paused run resumes mid-PR (e.g. re-enter `waiting_ci` without re-doing work). aitm's `WorkLoop.runGroup` does work→PR→CI-wait→review→merge inline (`work-loop.ts:135`), so an interrupt mid-lifecycle loses position. Add a **per-group** persisted stage and drive `runGroup` off it.

Source ref: `core/orchestrator.py:1034` (`_run_workflow_cycle`), `core/workflow_stages.py` (per-stage handlers), `state.py` (`workflow_stage` field + transitions).

## Files to change
- `src/state/schema.ts:15` (`PrGroup`) — add `stage: GroupStage` where `GroupStage = 'pending'|'working'|'pr-open'|'waiting-ci'|'ci-failed'|'waiting-reviews'|'addressing-reviews'|'ready-to-merge'|'merged'|'blocked'`. (Per-group, not global — aitm runs groups concurrently; see overview risk.) Keep existing `status` for coarse reporting or fold into `stage`.
- `src/loop/work-loop.ts:135` (`runGroup`) — refactor into a stage dispatcher: a `switch (group.stage)` advancing one transition per iteration, persisting after each. Mirror claudetm's `_run_workflow_cycle`. Keep concurrency batching (`work-loop.ts:113`) and `StateWriteAfterSuccess` (`work-loop.ts:94`).
- `src/loop/stage-handlers.ts` — **new**. One pure-ish handler per stage (`handleWorking`, `handlePrOpen`, `handleWaitingCi`, `handleCiFailed`, `handleWaitingReviews`, `handleAddressingReviews`, `handleReadyToMerge`). Each takes deps (github, state, subagents, prContext) + group, returns next stage. SRP: one stage per function. `ci-failed`/`addressing-reviews` bodies live in slice `04`.
- `src/loop/stage-handlers.test.ts` — **new**.
- `src/state/state-store.ts` — persist group stage transitions via existing `update(mutator)` (`state-store.ts:46`).

## Steps
1. Add `stage` to `PrGroup` (default `pending`); coerce legacy state on read (`state-store.ts:33`) — missing stage → infer from `status`/`pr` (`merged`→`merged`, `pr!=null`→`waiting-ci`, else `pending`).
2. Extract current inline `runGroup` body into the stage handlers; `runGroup` becomes: load group, loop `handler[stage]`, persist new stage, until terminal (`merged`/`blocked`) or a stage yields (e.g. `waiting-ci` returns to let the batch breathe — keep polling inside `waitForChecks` but persist stage before/after).
3. Map transitions exactly to claudetm: `working→pr-open→waiting-ci→(ci-failed→waiting-ci | waiting-reviews)→(addressing-reviews→waiting-reviews | ready-to-merge)→merged`. `ci-failed`/`addressing-reviews` delegate to slice `04`.
4. Resume: `WorkLoop.run` (`work-loop.ts:113`) picks each group up at its persisted stage instead of restarting. PR-take-over path in `runMergePr` reuses the same handlers from `waiting-ci`.

## Tests
- Unit `stage-handlers.test.ts`: each handler returns the correct next stage given stubbed github/state; terminal stages don't advance.
- Unit `work-loop.test.ts`: a group resumed at `waiting-ci` does NOT re-run Worker; full happy-path walks `pending→merged`; a blocked group stops.
- Integration `resume-flow.test.ts` (extend): interrupt after PR open, resume → continues at `waiting-ci` (stubbed gh).
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- Each `PrGroup` carries a persisted `stage`; `WorkLoop` resumes any group mid-lifecycle without redoing prior stages; transition map matches claudetm. Existing happy-path integration tests stay green.

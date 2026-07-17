# 03 — PR / CI / review loop correctness

> Part of [`overview.md`](overview.md). Depends on: none (coordinate branch/push helpers with `02`).

Unattended, the PR lifecycle must never lose a fix, merge a red head, or spin forever. These are the loop-integrity bugs.

## Files to change
| `file:line` | Sev | Problem | Fix |
| --- | --- | --- | --- |
| `loop/work-loop.ts:746-783` (`autoMergeFlow`) | HIGH | prPerTask+autoMerge commits CI/Reviewer fixes locally (`--amend`, `orchestrator.ts:286`) but **never pushes** before `waitForChecks`/`mergePr` → fix never reaches remote; re-polls stale CI; merges un-updated head; `--amend` diverges local from pushed remote. | Route through `runFixSession`/`rebaseAndForcePush` (`loop/ci-fix.ts`); force-with-lease push before recheck/merge. Mirror the stage-machine path. |
| `github/github-client.ts:189-216` + `aggregateChecks:561-571` | MED-HIGH | `aggregateChecks` returns `success` on `rows.length===0`; `waitForChecks` checks before any delay → a fresh PR whose Actions haven't registered "succeeds" instantly and merges before CI runs. | Wait `CI_START_WAIT` before the first poll; treat empty rows as pending for a bounded grace. |
| `loop/resume-normalize.ts:30-38` × `loop/work-loop.ts:454-464` | MED | `normalizeResumeStatus` resets `blocked`→`pending`; `ctx.fixAttempts` is in-memory per run (#128). An unfixable red PR re-runs the full coding-tier CI-fix budget on **every** `aitm start` — no durable "needs human" stop. | Persist a durable attempt count / `human-needed` flag on `RunState` that survives resume; stop rescheduling once exceeded. |
| `github/github-client.ts:331-364, 366-399` | LOW-MED | `paginateReviewThreads` (`while(true)`) / `paginateThreadComments` (`while(cursor)`) advance only on server `endCursor`; a stuck-cursor `hasNextPage=true` loops forever. | Bound page count; break on non-advancing cursor. |
| `subagents/reviewer.ts:222-224` + `130-152` | HIGH | `kind:"fixed"` unconditionally `git add -A && commit`; empty diff → non-zero exit → `runBash` throws → `runReviewer` returns `{kind:'error'}` **discarding every resolution accumulated this pass**. Contradicts "one bad thread doesn't abort the rest." | Check `git diff --cached --quiet` before commit; downgrade empty to `replied`/`wontfix`. Catch per-thread. |
| `subagents/planner.ts:150-163` (`capGroups`) | MED | Drops overflow groups but never rewrites `dependsOn`; a kept group can `dependsOn` a dropped id → `PlanGraph.validate` throws "depends on unknown group", rejecting an otherwise-good plan. | After capping, strip/remap dangling `dependsOn` (redirect to merged last-kept group). |
| `plan/plan-graph.ts:25-40` (`blocked`/`isComplete`) | MED | A `pending` group whose dep becomes `blocked` is never `ready()` and never transitions to terminal → `isComplete()` can stay false forever. | Compute transitive block (any blocked/failed ancestor ⇒ terminal); feed `isComplete`/drive loop. |
| `orchestrator/orchestrator.ts:269` | MED | `stopWhen:[stepCountIs, hasToolCall('done')]` but there is no `done` tool → the explicit-completion signal can never fire; only `stepCountIs` backstops. | Register a `done`/`finish` tool, or remove the dead condition. |
| `orchestrator/orchestrator.ts:221-227, 269` (`resolveMaxSteps`) | LOW | `maxSessions` (a PR/session count) fed directly into `stepCountIs()` as the LLM step budget — conflates two concerns. | Separate `maxSteps` (loop cap) from any session count. |
| `loop/run-loop-adapter.ts:1231` (`addressReviews`) | LOW | Plain `git push` after Reviewer commit; if an earlier ci-fix force-pushed a rebase, this non-ff push fails and blocks the group. | Route through `rebaseAndForcePush` / handle non-ff. |
| `loop/constants.ts:12-15` | LOW | `CI_START_WAIT`/`CI_POLL_*`/`MERGE_STATE_WAIT` defined + tested but unused; `github-client.ts` uses its own `CHECKS_*`. Masks bug row 2. | Wire them (they fix row 2) or delete. |

## Steps
1. Fix `autoMergeFlow` push gap first (data-loss) — reuse `rebaseAndForcePush`; align with the stage-machine path.
2. Add CI start-wait grace (wire `CI_START_WAIT`); empty-rows ⇒ pending until grace elapses.
3. Persist durable fix-attempt / human-needed state; `normalizeResumeStatus` must not resurrect a human-needed group.
4. Bound both paginators.
5. Reviewer: empty-index guard + per-thread error isolation.
6. Planner `capGroups`: remap dangling deps. PlanGraph: transitive-block terminality.
7. Orchestrator: real `done` tool (or drop dead condition) + separate `maxSteps` from `maxSessions`.
8. `addressReviews`: force-with-lease path.

## Tests
- Integration (temp repo + stubbed `gh`): autoMerge path — a CI fix is visible on the remote branch before merge; merging a red head is impossible. Fresh PR with no checks yet waits the grace, doesn't insta-merge. An unfixable PR stops after `maxCiFixAttempts` and stays stopped across a simulated resume. Reviewer with one empty-diff "fixed" thread still returns the other resolutions.
- Unit: `capGroups` over a plan with cross-group deps → no dangling `dependsOn`, `PlanGraph.validate` passes. Transitively-blocked graph → `isComplete()` true. Paginator with a stuck cursor terminates. `resolveMaxSteps` decouples the two counts.
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- Every CI/review fix is pushed before recheck/merge; no red-head merge; no diverging `--amend`.
- No premature merge on an unregistered-CI PR; no forever-loop on pagination or transitive blocks; no infinite budget burn on an unfixable PR.
- Planner output with dropped overflow groups still validates.

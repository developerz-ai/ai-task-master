# 01 — PR lifecycle idempotency

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `packages/aitm/src/loop/run-loop-adapter.ts:1031-1046` — `openPr` bridge: check-before-create.
- `packages/aitm/src/github/github-client.ts:165-201` — `createPr` reuse path.
- `packages/aitm/src/loop/stage-handlers.ts:98-106` — `handlePrOpen` resume semantics.
- `packages/aitm/src/loop/work-loop.ts:338-343,604-617,717-725,887-895` — awaiting-pr outcome, partial-group terminal status, prPerTask PR-open.
- `packages/aitm/src/cli/args.ts` — reject bad flag combo (if that option chosen).

## Steps
1. **Idempotent PR open** (durability #1, high). `openPr`/`createPr`: call existing `getPrForBranch(head)` first; if a PR already exists for the branch, adopt it (return its number) instead of `gh pr create`. Kill-after-create/before-persist then resumes cleanly instead of blocking the group.
2. **prPerTask + no-automerge** (logic #2). `processGroup` (`work-loop.ts:396,400-427`): with `canResetToBase` false, task ≥2 re-creates a PR from the same head branch → GitHub rejects → group blocked. Per owner decision (overview risks): either reject the combo in `args.ts` up front, or open one PR after the last task (group mode path). Step 1 makes the crash harmless either way; this fixes the by-design double-create.
3. **awaiting-pr under autoMerge** (logic #3). `finalResult` (`work-loop.ts:887-895`): surface `awaiting-pr` outcomes as non-success even when `autoMerge` — a `StateWriteAfterSuccess` at pr-open must not exit 0 with a dangling unmerged PR.
4. **Partial group ≠ `merged`-and-forgotten** (logic #4 / durability #3). `workTasks` (`work-loop.ts:604-617`): a group with any task left `done:false` must not land in terminal `merged` with exit 0. Per owner decision: mark blocked, introduce `partial`, or reschedule remaining tasks. Minimum bar: run result reflects dropped work (non-success or explicit partial report).

## Tests
- Unit: `work-loop.test.ts` — finalResult awaiting-pr × autoMerge matrix; workTasks partial-group terminal status.
- Unit: `github-client.test.ts` — createPr adopts existing PR (mock runCmd).
- Integration (`packages/aitm/test/integration/`): extend `crash-durability.test.ts` — kill between pr-create and state persist, resume, assert single PR + group completes. prPerTask+no-automerge 2-task group asserts chosen behavior.
- `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- Crash at the pr-open boundary resumes to exactly one PR; no recoverable state reaches `blocked`.
- No exit-0 run with a dangling PR or an un-done task in a merged group.

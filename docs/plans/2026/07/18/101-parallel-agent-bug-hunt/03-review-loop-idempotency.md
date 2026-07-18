# 03 — Review-loop + resume idempotency

> Part of [`overview.md`](overview.md). Depends on: none (pairs well with 01).

## Files to change
- `packages/aitm/src/subagents/reviewer.ts:150-158,241-279` — partial-resolution return on mid-pass throw.
- `packages/aitm/src/loop/stage-handlers.ts:155-166,181-185` — addressed-thread recording order / reviewer skip-if-replied.
- `packages/aitm/src/state/pr-context-store.ts:113-128` — `recordAddressedThreads` intent-first option.
- `packages/aitm/src/loop/work-loop.ts:288,636-656,746-760,865-874` — sessionCount timing; task-commit resume dedup.

## Steps
1. **Keep partial resolutions** (durability #4). `runReviewer`: a `commitFix` throw (`reviewer.ts:260-263`) currently discards resolutions already replied/resolved on GitHub → next run re-feeds those threads → duplicate replies + commits. Return resolutions gathered before the throw (the `reviewer.ts:270` empty-index comment already intends this) so `recordAddressedThreads` records them.
2. **Close the record gap** (durability #5). Side effects land before the dedup record; crash between = re-processing on resume. Either record intent-to-address before acting, or (simpler, self-healing) make the reviewer skip threads already carrying a bot reply — check thread comments in `freshThreads` (`stage-handlers.ts:181-185`). Prefer the skip: it also heals step 1's residue.
3. **sessionCount per-group** (durability #6). `run()` (`work-loop.ts:288`) persists `incrementSessionCount(batch.length)` before the batch runs; crash inflates the count → premature `session-cap` block on resume. Increment as each group actually starts.
4. **Duplicate task commit on resume** (durability #7). Crash after Worker commit, before `completeTask` persists (`work-loop.ts:746-760`): re-run adds a second commit for the same task on the reused branch. Detect the task's commit already on the branch (trailer or message marker via `git log`) and skip straight to `completeTask`. Harmless under squash-merge; wrong under merge/rebase methods.

## Tests
- Unit: `reviewer.test.ts` — commitFix throw at thread N returns resolutions 1..N-1. `stage-handlers.test.ts` — already-replied thread filtered. `work-loop.test.ts` — sessionCount increments per started group.
- Integration: extend `resume-flow.test.ts` / `crash-durability.test.ts` — kill after reviewer reply before record → resume produces no duplicate reply; kill after task commit before completeTask → resume produces no duplicate commit (`git log` count).
- `bun test`, `bun run test:node`.

## Done when
- Re-running after any crash in the review/commit path produces zero duplicate GitHub replies, resolutions, or commits.
- Persisted sessionCount never exceeds groups actually started.

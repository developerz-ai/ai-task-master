# 04 — CI-fix loop (download failed logs + comments → fix → re-poll → merge)

> Part of [`overview.md`](overview.md). Depends on: 03 (stage machine provides `ci-failed`/`addressing-reviews` slots).

The headline feature. Claudetm: on CI failure, download failed-run logs + unresolved review comments to `debugging/pr/<pr>/{ci,comments}/`, run a fix session (strongest model) instructed to read those dirs, **rebase onto base then `git push --force-with-lease`**, wait `CI_START_WAIT`, re-poll, loop to a cap. Same loop powers `merge-pr <n>`. aitm has all the primitives but `waitForChecks` (`github-client.ts:161`) throws `CiFailed` instead of entering a fix loop.

Source ref: `cli_commands/fix_pr.py:168` (merge-pr loop, 30 iters), `ci_helpers.py:54` (`wait_for_ci_complete`, poll 10s / timeout 90m), `fix_session.py:31`, `workflow_stages.py:463` (`handle_ci_failed_stage`), `:798` (`handle_addressing_reviews_stage`), `core/pr_context.py` (`save_ci_failures`/`save_pr_comments`/`post_comment_replies`).

## Files to change
- `src/github/github-client.ts:161` (`waitForChecks`) — split: keep the backoff poll, but return a structured `CiResult { state: 'success'|'failure'|'pending', failedChecks: [...] }` instead of throwing on failure. Callers decide. (Keep `CiFailed` for the terminal/timeout case.) Add `getFailedCiLogs` usage downstream (already exists, `:190`).
- `src/state/pr-context-store.ts` — confirm/extend `saveCiFailures(pr, logs)` and `saveComments(pr, threads)` write `debugging/pr/<pr>/ci/failed_<check>.txt` and `comments/<n>_<file>_<line>.txt` (claudetm layout). Add `addressedThreads` tracking (`debugging/pr/<pr>/addressed_threads.json`) to avoid re-processing.
- `src/loop/stage-handlers.ts` (from `03`) — implement:
  - `handleCiFailed`: `getFailedCiLogs` + `listUnresolvedThreads` → `prContext.saveCiFailures`/`saveComments` → run **fix session** (Worker with a fix prompt pointing at the `debugging/` dirs, `push_only` semantics) → rebase+force-push → set stage `waiting-ci`.
  - `handleAddressingReviews`: `listUnresolvedThreads` minus `addressedThreads` → `Reviewer` (already loops threads, `reviewer.ts:125`) → `replyToThread`/`resolveThread` → record addressed → stage `waiting-reviews`.
- `src/loop/ci-fix.ts` — **new**. Shared helper: `runFixSession({github, prContext, subagents, group, pr})` used by both `handleCiFailed` and `merge-pr`. Encapsulates download→fix→rebase→force-push. SRP.
- `src/loop/ci-fix.test.ts` — **new**.
- `src/cli/commands.ts:262` (`runMergePr`) — wrap the existing take-over+merge in the iteration loop: `for i in 1..maxIterations { waitForChecks; if failure||unresolved||conflict → runFixSession + sleep(startWait); else break } → mergePr`. Add `--max-iterations` to `args.ts:137` (`parseMergePr`), default 30.
- `src/loop/constants.ts` — **new** or extend: `CI_POLL_INTERVAL` (10s), `CI_START_WAIT` (60s), `CI_POLL_TIMEOUT` (claudetm uses 600s in-loop / 5400s in merge-pr — pick 600s for WorkLoop stage, configurable), `MERGE_STATE_WAIT` (60s), `DEFAULT_MAX_ITERATIONS` (30).

## Steps
1. Make `waitForChecks` return `CiResult` (keep backoff `:162-183`). Update existing callers in `work-loop.ts` to branch on `state`.
2. Implement `runFixSession` (`ci-fix.ts`): download failed logs (`getFailedCiLogs`) + comments (`listUnresolvedThreads`) → persist to `PrContextStore` → build fix prompt: "Read `.ai-task-master/debugging/pr/<pr>/ci/` and `/comments/`, fix ALL failures, then: `git fetch origin <base>`, `git rebase origin/<base>`, resolve conflicts, `git push --force-with-lease`." Run via Worker on the group's worktree/branch. Use `Credentials` coding capability (`credentials.ts:13`) — no hardcoded model.
3. Wire `handleCiFailed`/`handleAddressingReviews` (slice `03` handlers) to `runFixSession`/`Reviewer`; persist stage after each.
4. `runMergePr`: implement the bounded loop with `DEFAULT_MAX_ITERATIONS`, `CI_START_WAIT` between iterations, `MERGE_STATE_WAIT` for `mergeable==UNKNOWN`, then `mergePr` (existing `:414`). Exit codes: 0 merged, 1 cap-exhausted/conflict, 2 cancelled.
5. Always `--force-with-lease`; never plain force. Rebase before every push. Don't resolve threads the agent didn't address.

## Tests
- Unit `ci-fix.test.ts`: given a `CiResult: failure`, asserts logs+comments saved to the right paths, fix prompt references the debugging dirs, rebase+`--force-with-lease` invoked (stub `RunCmd`).
- Unit `stage-handlers.test.ts` (extend): `handleCiFailed`→`waiting-ci`; `handleAddressingReviews` skips already-addressed threads.
- Unit `github-client.test.ts`: `waitForChecks` returns structured `CiResult` for success/failure/pending; timeout still throws.
- Integration (new `test/integration/ci-fix-loop.test.ts`): temp git repo + stubbed `gh` scripted to fail CI once then pass → loop downloads logs, runs (stubbed-model) fix, re-polls, merges. Mirror `test/integration/start-flow.test.ts` setup (`testing/temp-repo.ts`, `MockLanguageModelV3`).
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- On CI failure, a run downloads failed logs + unresolved comments to `.ai-task-master/debugging/pr/<pr>/`, runs a fix session, rebases + force-with-lease pushes, re-polls, and merges when green — capped, resumable, in both `start` (WorkLoop) and `merge-pr`. Integration test proves the fail→fix→green→merge cycle.

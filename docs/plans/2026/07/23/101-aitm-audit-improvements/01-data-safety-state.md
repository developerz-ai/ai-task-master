# 01 — Data safety & state integrity

> Part of [`overview.md`](overview.md). Depends on: none.
> Findings: [`findings/04-github-state-workspace-fs.md`](findings/04-github-state-workspace-fs.md) (bugs 1, 2, 9, 10, 18; resources 2-4), [`findings/03-cli-config.md`](findings/03-cli-config.md) (bug 3).

## Files to change
- `packages/aitm/src/workspace/in-place-checkout.ts:145-153` — `ensureCleanTree` destroys pre-existing uncommitted user work via `git reset --hard` + `git clean -fd`.
- `packages/aitm/src/state/state-store.ts:43-48` — `init` silently overwrites existing `state.json`; no cross-process lock (`:24-77`).
- `packages/aitm/src/state/schema.ts:111-135` — no `schemaVersion`; ad-hoc read-time coercions.
- `packages/aitm/src/state/state-store.ts:224-226` — duplicate legacy task ids break resume dedup.
- `packages/aitm/src/cli/commands.ts:689-695` — `merge-pr --no-resume` clobbers a mid-plan run via `state.init()`.
- `packages/aitm/src/workspace/task-commit-marker.ts:11-13` — non-line-safe task ids silently disable resume dedup.
- `packages/aitm/src/state/transcript-store.ts:169-171, 238-251` — un-fsynced `run-end` record; orphaned empty reserved ordinals.

## Steps
1. Dirty-tree guard: at run entry (first `acquire` of a run), if the tree is dirty, refuse with a clear message (or auto-stash behind a flag); keep auto-clean only between groups. See findings/04 item 1 for the distinction.
2. Add `StateStore` run lock: exclusive `run.lock` (open `wx`, pid inside) acquired in init/resume, released in try/finally; second process fails fast. Test with two store instances over one dir.
3. Make `StateStore.init` refuse when `state.json` exists unless `force: true`; update callers.
4. Fix `merge-pr --no-resume`: update `currentPr` in place (or refuse when `prGroups` non-empty) instead of `init()` clobber; extend `commands.test.ts:1101-1135` with a mid-plan-run seed.
5. Add `schemaVersion` to `RunStateSchema` + keyed migration table replacing the five per-field legacy escapes in `state-store.ts:212-248`.
6. `legacyTask`: suffix index into every legacy id, not just empty-slug.
7. `taskCommitTrailer`: reject/sanitize ids containing newlines.
8. Transcript store: retry/fsync the `run-end` record; prune empty reserved ordinals during `begin`.

## Tests
- Unit beside each module (`in-place-checkout.test.ts`, `state-store.test.ts`, `commands.test.ts`, `transcript-store.test.ts`). Two-instance lock contention; dirty-tree refusal; init-refuse; migration table round-trip.
- `bun test && bun run test:node && bun run typecheck`.

## Done when
- A dirty tree at run start can never be silently destroyed; concurrent runs fail fast; `--no-resume` never loses a plan; state files carry a version.

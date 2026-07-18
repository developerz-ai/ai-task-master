# 04 — GitHubClient parsing + caching

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `packages/aitm/src/github/github-client.ts:137,162,384,430,488` — unguarded `JSON.parse`.
- `packages/aitm/src/github/github-client.ts:481` — `repoMeta()` memoization.
- `packages/aitm/src/loop/work-loop.ts:302` + `packages/aitm/src/loop/run-loop-adapter.ts` — `defaultBranch()` resolved once.
- Rethrow boundaries: `work-loop.ts:344,703,1255`, `run-loop-adapter.ts:224,397`, `github-client.ts` throws — `{ cause }`.

## Steps
1. **Guard the five parses** (durability #2). `defaultBranch`, `getPrForBranch`, `paginateReviewThreads`, `paginateThreadComments`, `repoMeta` do bare `JSON.parse(r.stdout)`; `gh` can emit non-JSON on exit 0 (notices, proxy HTML, truncation) → raw `SyntaxError` aborts the run anonymously. Route through existing `safeJson` (`github-client.ts:541-547`) + `safeParse`; on failure throw an error naming the command with stdout excerpt and `cause`. Follow the already-guarded `getFailedCiLogs`/`tryParseChecks` pattern.
2. **Memoize `repoMeta()`** (N+1 #1, high). Owner/name are per-run constants, yet each `listUnresolvedThreads` (`:329`) / `getFailedCiLogs` (`:261`) call spawns `gh repo view` — 1-2× per poll tick in take-over (`take-over-flow.ts:199`, ≤30 iterations) and per stage transition (`stage-handlers.ts:182`). Cache first resolved `{owner,name}` on the instance.
3. **`defaultBranch()` once per run** (N+1 #2). `runGroup` re-derives it per group (`work-loop.ts:302`); `merge-flow-adapter.ts:22` already resolves once and threads `baseBranch` — do the same in `runLoopAdapter`, or memoize on the client alongside step 2.
4. **Preserve `cause`** (durability cross-cutting). At the listed rethrow boundaries replace `err instanceof Error ? err.message : String(err)` collapses with `new Error(msg, { cause: err })`. Pattern exists at `StateWriteAfterSuccess` (`work-loop.ts:248-257`). Sweep, don't refactor — same messages, add cause.

## Tests
- Unit: `github-client.test.ts` — mock runCmd returning exit-0 non-JSON for each of the five → descriptive error naming the command, `cause` set; repoMeta/defaultBranch invoked twice spawn one subprocess (call-count spy).
- Unit: cause preserved through one representative boundary per file.
- `bun test`, `bun run test:node`, `bun run lint`.

## Done when
- Zero bare `JSON.parse` on subprocess stdout in `github-client.ts`.
- One `gh repo view` per run regardless of poll ticks/groups.

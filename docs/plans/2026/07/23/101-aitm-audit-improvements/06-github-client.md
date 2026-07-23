# 06 — GitHubClient robustness

> Part of [`overview.md`](overview.md). Depends on: none (03 adds the timeout/signal plumbing; don't duplicate it here).
> Findings: [`findings/04-github-state-workspace-fs.md`](findings/04-github-state-workspace-fs.md) (bugs 3-8, 12, 13; arch 1-3, 5, 6).

## Files to change
- `packages/aitm/src/github/github-client.ts` — all items below.
- `packages/aitm/src/github/errors.ts` — dead domain errors; wire them in.
- `packages/aitm/src/github/check-tolerance.ts:74` — memoize `envRules()`.

## Steps
1. `defaultRunCmd` (`:49-58`): detect `err.code === 'ENOENT'` → throw `GhCliMissing`; surface `shortMessage` instead of flattening to `{exitCode:1, stderr:''}`. Wire the other domain errors (`GhAuthRequired`, `PrNotFound`) at their natural throw sites or delete them — the file header promises "always domain errors".
2. `waitForChecks` (`:236-278`): tolerate N consecutive transient poll failures before throwing; recognize "no checks reported" (non-zero exit + empty stdout) as an empty row set entering `CHECKS_EMPTY_GRACE_MS`; anchor the budget on `Date.now()` so gh latency and the initial wait count.
3. Kill `NODE_ENV === 'test'` instant-sleep (`:70-73`); require explicit `AITM_INSTANT_SLEEP`.
4. `failedRunIds` (`:313-327`): filter by head SHA server-side or paginate past `--limit 30`.
5. GraphQL pagination (`:432-434, 476-477`): append the current page's nodes before the non-advancing-cursor break; log on `MAX_REVIEW_THREAD_PAGES` truncation.
6. Merge-conflict classifier (`:572`): drop bare `conflict` from the regex.
7. `createPr` (`:218-220`): ensure labels once per run (cache like `cachedRepoMeta`).
8. `defaultBranch` (`:162-175`): Zod schema like every sibling.
9. Split for testability (SRP): extract `checks-poller.ts` (poll/backoff/tolerance policy) and `review-threads.ts` (GraphQL pagination) from the 857-line class; transport (`runCmd`) stays. Keep this split small — the full arch pass is slice 10.
10. Memoize `check-tolerance` env parsing per process.

## Tests
- `github-client.test.ts` (+ new paired tests for split modules): ENOENT → `GhCliMissing`; transient-failure tolerance; "no checks reported" grace; SHA-filtered run lookup; cursor-guard page retention; conflict-regex negative case (`label conflict`); NODE_ENV no longer affects sleeps.

## Done when
- A missing `gh`, a network flake, a checkless PR, and a >30-run branch all produce correct behavior instead of empty-message throws, aborted 2-hour waits, hard-fails, or silent `[]`.

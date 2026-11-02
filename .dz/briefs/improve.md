# Brief: monthly improvement

Fired every Monday by `schedules: improve`. **Act only on the first Monday of the month:**
`[ "$(date -u +%-d)" -le 7 ]`. On any other Monday stop here, file nothing, open nothing.

Once a month, leave aitm measurably better. `CLAUDE.md` binds every change, and `non_goals` in the policy file are off limits. A red `main`,
a missing publish and a stuck Dependabot PR belong to `health`.

## Signals

| Signal | Command |
|---|---|
| the gate on fresh `main` | `bun run lint && bun run typecheck && bun run typecheck:tests && bun run test:node` |
| dependency majors | `bun outdated` |
| open bugs | `gh issue list --state open --label bug --json number,title,url` |

## Pick at most three, in this order

1. Anything the gate found broken or flaky: the root cause, never a retry or a skip.
2. Dependency majors. A `bun.lock` resync is its own PR, never inside a release (`CLAUDE.md`).
3. Open bugs, each starting from a test that fails on `main`.
4. README claims that no longer match the code, then dead code.

## Ship

One small PR per improvement, its evidence in the body, `bun run lint && bun run typecheck && bun run typecheck:tests && bun run test:node` green first. Never bump the version or touch release automation here. No co-author trailers (`CLAUDE.md`).
Check no open PR or issue already covers it. If nothing is worth changing, do nothing: no empty PRs, no churn.

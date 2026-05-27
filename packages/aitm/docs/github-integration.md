# GitHub Integration

## Role

`GitHubClient` wraps the `gh` CLI (via `Bun.$`) and GitHub GraphQL (via `gh api graphql`). It is the only module allowed to shell out to `gh` — SRP.

## Capabilities

| Capability | Underlying call | Used by |
| --- | --- | --- |
| Detect current PR for branch | `gh pr view --json number,state,url` | `Worker`, `merge-pr` |
| Create PR | `gh pr create` | `Worker` |
| List unresolved review threads | GraphQL `pullRequest.reviewThreads` | `Reviewer`, `merge-pr` |
| Reply to / resolve review thread | GraphQL `addPullRequestReviewThreadReply`, `resolveReviewThread` | `Reviewer` |
| Check CI status | `gh pr checks --json` | `merge-pr` |
| Merge PR | `gh pr merge --squash` (configurable) | `merge-pr` |

## Result typing

All methods return typed results. JSON is parsed through Zod schemas. Errors are domain errors (`PrNotFound`, `ReviewThreadStale`, `CiFailed`, etc.) — never raw stderr strings.

## Rate limits

GraphQL queries are batched per PR (threads + comments fetched in one request). CI status polling uses exponential backoff: 1s start, doubling, 60s cap.

## No server

No webhook listener. No long-running process. `merge-pr` is a polling command the user runs on-demand.

## Branch hygiene

`GitHubClient` exposes `currentBranch()` and `defaultBranch()` so `Worker` can rebase safely. `GitHubClient` itself does not perform git operations — git runs via `Bun.$` directly inside the `Worker` bash tool. This keeps `GitHubClient` GitHub-only.

## Cross-links

- `./commands/merge-pr.md`
- `./subagents.md`
- `./auth.md`

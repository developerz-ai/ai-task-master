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

## Idempotent merge

`mergePr` is idempotent on an already-merged PR. A resume can re-drive the merge stage after a crash in the window between `gh pr merge` succeeding on GitHub and `state.json` persisting `merged`; running `gh pr merge` again then exits non-zero. Rather than trust gh's version-varying wording (which phrases "already merged" as "not mergeable", the same words a real conflict uses), a non-zero merge exit confirms the PR's real state via `gh pr view --json state` — `MERGED` → success (the desired end state is already true), anything else → the existing conflict/generic handling. The state check is best-effort, so a genuine merge failure still surfaces.

## CI check summary

Polling is silent per-iteration (exponential backoff, no line-per-poll spam). When CI **settles**, `waitForChecks` carries the final check rows on `CiResult.checks`, and the loop prints one summary line — `group g1: CI success — bun (test + lint) ✓, CodeRabbit ✓` — so the operator sees what passed/failed without watching GitHub. A ✓ for pass/skipping, ✗ for fail/cancel; no checks configured → no line.

## Rate limits

GraphQL queries are batched per PR (threads + comments fetched in one request). CI status polling uses exponential backoff: 1s start, doubling, 60s cap.

## Cancelling a CI wait

`waitForChecks(pr, signal?)` takes the run's abort signal: it cancels the start grace and every backoff, and the loop checks `signal.aborted` at the top of each poll so a Ctrl-C stops within one in-flight `gh pr checks` instead of the 120-minute timeout. A cancelled wait returns `{ state: 'pending' }` — **not** a verdict. Callers (`handleWaitingCi`, the take-over loop, the prPerTask auto-merge flow) re-check the signal before branching, so a cancel never reads as a CI failure (an LLM fix pass) or as "nothing failing" (a merge).

## Child-process deadlines

Every `gh`/`git` child spawned by `GitHubClient` runs under a deadline (`DEFAULT_CMD_TIMEOUT_MS`, 5 min; override per call with `RunCmdOptions.timeout`) and, when the run supplies one, under the run's abort signal — bound once in the constructor, so a Ctrl-C kills an in-flight `gh` instead of leaving it for the force-exit path to orphan. Note what this is *not*: `CHECKS_TIMEOUT_MS` bounds how many times `waitForChecks` polls, never how long a single `gh` invocation may hang, so before these deadlines a network-wedged `gh api …/logs` blocked the run forever. A child killed by either route reports execa's own summary as `stderr` ("Command timed out after 300000 milliseconds: gh …"), since a signal-killed process writes no error of its own and callers render failures as `<cmd> failed: <stderr>`.

The same treatment applies at the other subprocess chokepoints: `runGit` (`DEFAULT_GIT_TIMEOUT_MS`, 10 min — network subcommands are the ones that wedge), the Orchestrator's `git commit --amend` seam (1 min), and `fetch_html`'s `curl-impersonate` (the tool call's own `abortSignal`).

## No server

No webhook listener. No long-running process. `merge-pr` is a polling command the user runs on-demand.

## Branch hygiene

`GitHubClient` exposes `currentBranch()` and `defaultBranch()` so `Worker` can rebase safely. `GitHubClient` itself does not perform git operations — git runs via `Bun.$` directly inside the `Worker` bash tool. This keeps `GitHubClient` GitHub-only.

## Cross-links

- `./commands/merge-pr.md`
- `./subagents.md`
- `./auth.md`

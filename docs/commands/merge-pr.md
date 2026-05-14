# `aitm merge-pr`

Drive an open PR to merge, then advance to the next PR group.

In the default automerge-on flow this logic runs **inline** inside `aitm start` — you only invoke `aitm merge-pr` directly when `--no-automerge` was used, or to resume a paused run.

## Signature

```
aitm merge-pr
  [--pr N]          # default: state.json.currentPr
  [--no-resume]     # default: continue to next PR group after merge
```

## Preconditions

- `.ai-task-master/state.json` exists with `status: awaiting-pr` (or `--pr` provided explicitly).
- `gh` CLI authenticated.
- `OPENROUTER_API_KEY` set.

## Flow

1. `CLI` loads state via `StateStore`.
2. `GitHubClient` fetches PR status and CI checks. Polls with exponential backoff until checks are conclusive.
3. On CI failure: `Orchestrator` invokes `Worker` with failure logs to fix and push.
4. `GitHubClient` fetches unresolved review comments via GraphQL.
5. On unresolved comments: `Orchestrator` invokes `Reviewer` to address each, push fixes, request re-review, resolve threads.
6. Loop 2–5 until checks green AND no unresolved comments remain.
7. `GitHubClient` merges (squash by default). `StateStore` marks the group merged.
8. Unless `--no-resume`: re-enter `WorkLoop` on the next PR group. Otherwise exit 0.

## Defaults

| Behavior | Default | Override |
| --- | --- | --- |
| Automerge after green | on | `--no-automerge` on `aitm start` |
| Merge strategy | squash | `--merge-method merge\|rebase` |
| Resume to next group | on | `--no-resume` |

## Failure modes

| Mode | Handling |
| --- | --- |
| Merge conflict | `Worker` rebases onto base, retries push. |
| CI flaky | Backoff with jitter, retry within session cap. |
| Persistent failure | Exit 1, state preserved for inspection / resume. |

## See also

- `./start.md`
- `../task-groups.md`
- `../subagents.md`
- `../github-integration.md`

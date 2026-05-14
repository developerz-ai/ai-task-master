# Task groups (PRs)

A goal is split into ordered **task groups**. One group = one PR. `Planner` chooses the split; `--max-prs` caps how many it may emit.

## Why group

Single-PR runs scale badly: a 2000-line PR is unreviewable and a 5-task PR is unrevertable. Grouping is the unit of human review and the unit of rollback.

## Sizing heuristic

`Planner` aims for groups that are each:

- Cohesive — same feature, same file area, or same refactor target.
- Self-contained — merges cleanly without depending on later groups beyond an agreed interface.
- Reviewable — soft target of ~ 300 changed lines per PR.
- Reversible — revert of one group leaves the rest of the codebase consistent.

Hard cap: `options.maxPrs` (CLI `--max-prs N`, default `5`). If `Planner` cannot fit the goal into the cap, it returns the first N groups plus a `remainder` task and `WorkLoop` exits with status `blocked` after the cap is reached — the user re-runs `aitm start` to continue.

## Schema

Persisted in `state.json.prGroups`. See `./state.md` for the field-level schema (`id`, `title`, `tasks`, `branch`, `pr`, `status`).

## Lifecycle

| Step | Owner | Effect on group |
| --- | --- | --- |
| Plan | `Planner` | status `pending` |
| Branch created | `Worker` | `branch` set, status `in-progress` |
| PR opened | `Worker` via `GitHubClient` | `pr` set, status `awaiting-pr` |
| Automerged | `merge-pr` inline (or manual `aitm merge-pr`) | status `merged` |
| Failure | any | status `blocked`, run exits 1 |

`WorkLoop` only advances when the current group is `merged`. With `--no-automerge`, the run exits at `awaiting-pr` and the user runs `aitm merge-pr` to drive the group to `merged`, then can run `aitm start` again (no goal arg) to resume on the next group.

## Branching

| Convention | Owner |
| --- | --- |
| Base branch | `GitHubClient.defaultBranch()` |
| Group branch name | `aitm/<runId>/<group.id>` |
| One branch per group | `Worker` |

Branches are deleted after merge (squash strategy).

## Cross-links

- `./commands/start.md`
- `./commands/merge-pr.md`
- `./state.md`
- `./subagents.md`

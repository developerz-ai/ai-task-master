# `aitm start`

Kick off an autonomous work session against a goal. With automerge on (default) the run drives every PR to merge by itself.

## Signature

```
aitm start "<goal>"
  [--criteria "..."]
  [--max-prs N]            # default 5
  [--max-sessions N]       # default unlimited
  [--no-automerge]         # default: automerge on
  [--style <path>]         # default: detected CLAUDE.md or AGENTS.md
  [--model <id>]           # default: provider default
```

## Preconditions

Checked by `CLI` before launching `WorkLoop`.

| # | Check | Owner |
| --- | --- | --- |
| 1 | Target repo contains `CLAUDE.md` or `AGENTS.md` (errors if neither, unless `--style` given). | `AgentConfigDetector` |
| 2 | `OPENROUTER_API_KEY` is set. | `Credentials` |
| 3 | `gh` CLI authenticated. | `CLI` |
| 4 | Clean git working tree — warn otherwise, do not block. | `CLI` |

## Flow

1. `CLI` parses args, validates preconditions, persists run options to `state.json.options` (`autoMerge`, `maxPrs`, `maxSessions`, `stylePath`).
2. `StateStore` creates `.ai-task-master/`, writes `goal.txt`, optional `criteria.txt`, initial `state.json` with `status: planning`.
3. `Orchestrator` invokes `Planner` subagent. `Planner` returns **PR groups** — an ordered list of groups, each containing the tasks that ship in one PR. Group count is capped by `--max-prs`. `StateStore` persists this as `plan.md` plus structured `prGroups` in `state.json`.
4. `WorkLoop` iterates groups. For each group:
   1. `Orchestrator` invokes `Worker` with the group's task list plus `context.md`.
   2. `Worker` works the group end-to-end on a dedicated branch, then opens one PR via `GitHubClient`.
   3. `state.json.status = awaiting-pr`, `currentPr` set.
   4. If `autoMerge` is on: `WorkLoop` invokes the same logic as `aitm merge-pr` inline — wait for CI, address review comments via `Reviewer`, merge. On merge success: advance to next group.
   5. If `autoMerge` is off: exit 0 with a message instructing the user to run `aitm merge-pr`.
5. When all groups are merged: `StateStore` cleans state (logs retained), exit 0.

No final verification phase. No release phase. The merge of the last PR is the terminal event.

## Task groups (PRs)

| Concept | Owner | Persisted to |
| --- | --- | --- |
| Group | `Planner` | `state.json.prGroups[i]` |
| Tasks within a group | `Planner` | `state.json.prGroups[i].tasks` |
| Branch for a group | `Worker` | `state.json.prGroups[i].branch` |
| PR number for a group | `Worker` | `state.json.prGroups[i].pr` |

`Planner` chooses group boundaries by cohesion (same feature, same file area) and reviewability (target ~ 300 changed lines per PR, soft).

## Coding style

`AgentConfigDetector` reads `CLAUDE.md` or `AGENTS.md` and produces a coding-style payload. That payload is prepended to every subagent system prompt. `--style <path>` overrides both. See `../coding-style.md`.

## Termination signals

| Signal | Exit code |
| --- | --- |
| All PR groups merged | 0 |
| PR opened, `--no-automerge`, awaiting `aitm merge-pr` | 0 |
| `--max-prs` reached before goal complete | 0 |
| `--max-sessions` reached | 0 |
| Blocked | 1 |
| Ctrl-C | 2 |

## See also

- `./merge-pr.md`
- `../task-groups.md`
- `../coding-style.md`
- `../subagents.md`
- `../state.md`
- `../agent-config-detection.md`

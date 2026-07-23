# `aitm start`

Kick off an autonomous work session against a goal. With automerge on (default) the run drives every PR to merge by itself.

## Signature

```text
aitm start "<goal>"
  [--criteria "..."]
  [--max-prs N]            # default 5
  [--max-sessions N]       # default unlimited
  [--max-fix-attempts N]   # default 3 — CI-fix passes per PR group before it blocks
  [--concurrency N]        # default 1 — PR groups worked in parallel
  [--no-automerge]         # default: automerge on
  [--admin]                # merge past base-branch protection (gh pr merge --admin)
  [--style <path>]         # default: detected CLAUDE.md or AGENTS.md
  [--model <id>]           # default: provider default
  [--branch <name>]        # default: aitm/<group-id>
```

`--max-fix-attempts` and `--concurrency` override the persisted `maxCiFixAttempts` / `concurrency`
config keys for this run; `--no-automerge`, `--style`, and `--model` likewise override their config
counterparts. `--admin` is **CLI-only** — a per-run force-merge with no config-file key. The many
run settings that have **no** flag at all (e.g. `verifyCommand`, `selfReview`, `webSearch`) are
documented in [config.md](../config.md).

### `--max-fix-attempts`

Caps how many CI-fix passes a PR group gets before it blocks for a human instead of looping on an
unfixable red PR. Overrides the `maxCiFixAttempts` config key for this run (default `3`). Each
attempt is a coding-tier fix session plus a remote CI round-trip, so it is a direct cost/patience
knob. See [config.md](../config.md#maxcifixattempts).

### `--concurrency`

How many PR groups may have a Worker running at the same time (default `1`, sequential). Overrides
the `concurrency` config key for this run. See
[config.md](../config.md#concurrency-and-editorconcurrency).

### `--admin`

Merge with `gh pr merge --admin` to land a green PR past a base-branch protection rule that would
otherwise block a solo-authored merge. It overrides the *policy* only — it never skips CI or merges
failing checks (those still route to the CI-fix loop). Needed when running aitm against a repo whose
`main` requires an approving review. See the repo `CLAUDE.md` §"Branch protection".

### `--branch`

By default each PR group gets an `aitm/<group-id>` branch. Pass `--branch <name>` to control it:

- **Single-group plan** (e.g. `--max-prs 1`): the branch is used **verbatim** — the PR lands on exactly `<name>`.
- **Multi-group plan**: `<name>` becomes a **prefix** (`<name>/<group-id>`) so concurrent worktrees and their PRs never collide on one branch.

The name is validated as a git ref (no whitespace, leading `-`, `..`, control/special chars); an invalid name is a usage error.

### Auto-merge

Auto-merge is **on by default** — `aitm` merges every PR it opens once CI passes, via a `gh`
subprocess. Because that merge runs outside Claude Code's tool boundary, a host repo's Claude Code
git-guard hook cannot intercept it. To make this explicit, `start` prints a banner when auto-merge
is active:

```text
⚠ auto-merge is ON — every PR will be merged automatically when CI passes.
  PR merges run via `gh`, outside Claude Code's tool boundary, so host git-guard hooks cannot intercept them.
  Pass --no-automerge for this run, or `aitm config set autoMerge false` to disable it by default.
```

Pass `--no-automerge` (or run `aitm config set autoMerge false`, or set `autoMerge: false` in
`.ai-task-master/config.json`) to open PRs without merging them; finish each with `aitm merge-pr`.

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
| Branch for a group | `branchFor()` in `run-loop-adapter.ts` (from `--branch` or default `aitm/<id>`) | `state.json.prGroups[i].branch` |
| PR number for a group | `Worker` | `state.json.prGroups[i].pr` |

`Planner` chooses group boundaries by cohesion (same feature, same file area) and reviewability (target ~ 300 changed lines per PR, soft).

## PR descriptions

Every PR `aitm` opens uses a consistent body, composed by the `Orchestrator` from the worker's
delivery (see `PR_BODY_GUIDE` in `orchestrator.ts`):

```md
## Summary
<1-2 sentences: what changed and why>

## Changes
- <notable file/area changes>

## Testing
<how it was verified — tests, lint — or a note that it wasn't>
```

Titles are conventional-commit style, ≤72 chars.

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

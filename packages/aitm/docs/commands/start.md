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
  [--branch <name>]        # default: aitm/<group-id>-<title-slug>
```

### `--branch`

By default each PR group gets an `aitm/<group-id>-<title-slug>` branch — the slug makes a branch list readable (`aitm/g1-add-todo-crud`, not `aitm/g1`). Pass `--branch <name>` to control it:

- **Single-group plan** (e.g. `--max-prs 1`): the branch is used **verbatim** — the PR lands on exactly `<name>`.
- **Multi-group plan**: `<name>` becomes a **prefix** (`<name>/<group-id>-<title-slug>`) so concurrent worktrees and their PRs never collide on one branch.

The name is validated as a git ref (no whitespace, leading `-`, `..`, control/special chars); an invalid name is a usage error.

Names aitm composes are also deduped against `origin` at plan time: one `git ls-remote --heads` lists what already exists, and a colliding name takes a numeric suffix (`aitm/g1-add-todo-crud-2`). That matters when two people run aitm on the same repo toward the same goal — they get the same plan, hence the same names, and force-push is allowed by default. An unreadable remote degrades to the plain names, and a resumed run keeps the branch already in `state.json`. An explicit single-group `--branch` is never suffixed.

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
| Branch for a group | `branchFor()` in `run-loop-adapter.ts` (from `--branch` or default `aitm/<id>-<slug>`) | `state.json.prGroups[i].branch` |
| PR number + URL for a group | `Worker` | `state.json.prGroups[i].pr`, `.prUrl` |
| Acceptance check for a group | `Planner` | `state.json.prGroups[i].acceptance` |

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

## Evidence
<the verify command and its outcome, the group's acceptance check and whether it was
demonstrated, and what was checked then thrown away — or "Nothing was run to verify this change.">
```

Titles are conventional-commit style, ≤72 chars. Section headings are configurable per repo via `prBodySections` (see `../config.md`).

## Acceptance checks

Every PR group carries an `acceptance` check from the plan: the command to run or the behaviour to observe that proves the group done (`bun test src/auth passes and POST /login sets a session cookie`). It is required — a plan whose group arrives without one fails schema validation and goes back to the Planner — and it travels with the group: into the Coordinator's brief, into the pre-PR self-review, and into the PR body's Evidence section. A group is not done because the model says so; it is done when its check holds.

## Coding style

`AgentConfigDetector` reads `CLAUDE.md` or `AGENTS.md` and produces a coding-style payload. That payload is prepended to every subagent system prompt. `--style <path>` overrides both. See `../coding-style.md`.

## End-of-run output

Whatever the outcome, the run ends with two blocks on stdout:

```
Usage: 41 calls, 812304 in / 39118 out tokens (611200 cached, 75% cache hit), $1.8342 — planner …
Pull requests:
  #12  Todo CRUD API — https://github.com/you/repo/pull/12
  #13  Session cookie auth — https://github.com/you/repo/pull/13
```

The PR block lists every group that opened a PR, read from persisted state rather than the run result — so it appears on a merged run, on a run parked at `awaiting-pr`, and on a blocked one, where the PRs opened before the block are exactly what you want to look at. It is omitted entirely when the run opened none. Both blocks are best-effort: a reporting failure never changes the exit code.

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

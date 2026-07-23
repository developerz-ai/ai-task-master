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

## Sizing: what a group and a task are

A group is **one cohesive PR that delivers a whole capability end to end, tests included** — typically 2–5 tasks and several hundred added lines, up to ~1000 when the capability genuinely is that big. Size is judged by *reviewability*, not by a line ceiling: a reviewer needs no other group open to judge it, and it lands or reverts as one unit.

A task is **a coherent slice of behaviour together with the tests that prove it** — normally several files, roughly 100–400 lines. Never split a task by file. The reason is measured, not stylistic: every task pays a full repo survey before it writes a line, and that survey costs the same whether the task then writes 40 lines or 400. A timed run whose groups were decomposed per file spent ~49% of its wall-clock re-orienting and 11% writing code, and shipped 228- and 316-line PRs where a behaviour-sized decomposition was landing 1,400–2,000. A task touching one file is a smell unless the change genuinely is one file.

Two task shapes are forbidden outright, both of which produced zero code in that run:

- **verification tasks** — proving the group done is the group's `acceptance` field, and the tests belong inside the task that writes the behaviour;
- **tasks that re-do a sibling's work** — a task that arrives to find its work already in place returns nothing and burned a whole survey.

`PlannedGroupSchema.tasks` enforces 1–5 tasks. The cap's `.describe()` says *merge, never drop* — a bare `maxItems` would invite the model to truncate work — and the `min(1)` closes a hole where a zero-task group was valid and would have opened an empty PR.

## Branching

| Convention | Owner |
| --- | --- |
| Base branch | `GitHubClient.defaultBranch()` |
| Group branch name | `aitm/<group.id>-<title-slug>` (`branchFor`, `src/loop/run-loop-adapter.ts`) |
| One branch per group | `Worker` |

The title slug is what makes a branch list readable: `aitm/g1` says nothing next to `aitm/g1-add-todo-crud`. It is the group title lowercased, non-alphanumerics collapsed to `-`, truncated at a word boundary (40 chars), and dropped entirely when the title only restates the id (`g1` / "G1" → `aitm/g1`, never `aitm/g1-g1`).

`--branch <name>` still overrides: a single-group plan uses the requested name verbatim, and a multi-group plan prefixes each group as `<requested>/<id>-<slug>`.

Branches are deleted after merge (squash strategy).

## Cross-links

- `./commands/start.md`
- `./commands/merge-pr.md`
- `./state.md`
- `./subagents.md`

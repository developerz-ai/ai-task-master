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
  [--branch <name>]        # default: aitm/<group-id>-<title-slug>
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

## Resume vs. supersede

`aitm start` is idempotent for an **unfinished** run: re-running it in a directory whose `state.json` holds an in-progress run resumes at the exact lifecycle point (the runId, plan, and per-group stage are preserved). If the typed goal differs from the persisted one, a notice says `start` continues the old run and points at `aitm clean` to start over — it does not re-plan the new text onto an in-progress run.

A **finished** run is different: it is superseded. Re-running `aitm start "<new goal>"` where a prior run already merged every group (or reached `success`) used to silently resume that completed run — nothing left to do, 0 LLM calls, the old PR list reprinted, and the new goal never planned. It now starts fresh: re-init, re-plan the new goal, with a notice. `aitm resume` short-circuits a finished run first (exit 0, "already complete — nothing to resume"), so re-planning a finished goal never happens and the supersede stays a `start`-only concern. "Finished" = status `success`, or a non-empty plan whose every group is `merged`; a blocked/failed run stays resumable.

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

### When the model gets the shape wrong

The section contract used to be all-or-nothing: a body missing one heading was discarded and the PR opened with a generated stub instead. On a real five-group run that fired on **2 of 2** PRs — every body the operator actually got was the stub, and paragraphs of accurate prose about the diff were thrown away over a single absent heading. Two layers now stand between a near-miss and that outcome:

1. **Normalization.** Models get the sections right and the markup wrong. `### Changes`, `## Changes:`, `## **Changes**` are all rewritten to the canonical heading before the contract is checked — as is a *run-on* heading, where the model puts the content on the heading line itself (`## Summary Adds cookie auth`, `## Changes### Domain`), which is split into the heading plus a content line. A word-boundary guard means `## Changesets` never matches `## Changes`. Only heading lines are touched — prose mentioning a section name cannot fabricate one, and a `## …` quoted inside a code fence is content, not a heading.
2. **Repair.** If retries still leave the contract broken, the model's title and sections are **kept**, the missing sections are filled from the same deterministic material the stub used, and everything is emitted in the required order. Content the model wrote under an unrecognized heading folds into the section before it — never appended as a separate trailing block. That trailing-block behavior was a real bug: a model that ran content onto *every* heading line made every section read as unrecognized, so the whole body was re-emitted after the deterministic fill, producing a **doubled** PR body. Now every word survives exactly once, in section order.

The full generated fallback now only happens when the model never produced a schema-valid composition at all. The progress line tells you which path ran (`PR composition repaired: …` vs `PR composition fell back to generated title/body: …`).

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

## Resuming

`aitm resume` continues the run this directory already started. It takes every `start` flag, but no goal — the goal comes from `.ai-task-master/goal.txt` and the criteria from `.ai-task-master/criteria.txt`, so a resumed run can never drift onto a subtly different goal than the one its plan was built for. Retyping the goal is exactly how that drift happens.

```sh
aitm resume                 # continue where the last run stopped
aitm resume --admin         # …with a per-run flag
```

A directory that has never been started says so and exits 1 without touching the loop.

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

# 02 — Task / subtask execution model

> Part of [`overview.md`](overview.md). Depends on: 01 (digest available to prompts).

Claudetm executes a PR group task-by-task: each task carries a complexity marker, a checkbox in `plan.md`, and is marked `[x]` when done; `pr_per_task` decides PR-per-task vs PR-per-group. aitm's `PrGroup.tasks` is a flat `string[]` with no per-task state — a group is one Worker pass. Add per-task structure + completion tracking, keeping aitm's group-as-PR default.

Source ref: `core/task_runner.py:140` (group context), `:481` (task regex `^- \[[ x]\] (\[.*?\] )?(.*)$`), `:217` (run_work_session per task), `mark_task_complete`; `core/task_group.py` (`ParsedTask`/`TaskGroup`).

## Files to change
- `src/plan/schema.ts` / `src/state/schema.ts:15` (`PrGroup`) — change `tasks: string[]` → `tasks: Task[]` where `Task = { id, text, complexity: 'simple'|'normal'|'complex', done: boolean, subtasks?: string[] }`. Keep `Plan` schema (`plan/schema.ts:25`) in sync.
- `src/plan/plan-markdown.ts` — **new**. Parse/render `plan.md` checkbox+complexity format (`## Group: <name>` + `- [ ] [NORMAL] <task>`). Round-trips `Plan` ↔ markdown. SRP: markdown only.
- `src/plan/plan-markdown.test.ts` — **new**.
- `src/subagents/planner.ts:28` — planner output schema emits structured `Task[]` per group (complexity + optional subtasks), not bare strings. Update `PLANNER_SYSTEM_PREFIX` to ask for complexity tags.
- `src/subagents/worker.ts:80` — Worker input takes the current `Task` (or task slice) instead of the whole group when running per-task; manifest/editor phase unchanged.
- `src/loop/work-loop.ts:135` (`runGroup`) — iterate the group's tasks: run Worker per task, mark `task.done`, persist, render `plan.md` via `plan-markdown`. Open PR when last task in group completes (default) or per task if `prPerTask` set.
- `src/state/state-store.ts:69` (`writePlan`) — render via `plan-markdown` so `plan.md` carries checkbox state (claudetm parity).
- `src/cli/args.ts:61` (`parseStart`) — add `--pr-per-task` flag → `RunState.options.prPerTask`.

## Steps
1. Extend schemas (Zod) for `Task` + `prPerTask` option. Migrate any existing-state reads defensively (treat `string[]` as `[{text, complexity:'normal', done:false}]`) — there's no migration framework, so coerce on read in `StateStore.read` (`state-store.ts:33`).
2. Implement `plan-markdown` parse/render mirroring the claudetm regex; complexity tag optional → defaults `normal`. No checkboxes anywhere except `plan.md` itself.
3. Planner: emit `Task[]` with complexity. Reuse `Credentials` role→capability (`credentials.ts:13`) — complexity is metadata for ordering/reporting, not new model wiring unless trivial.
4. `runGroup`: loop tasks in order; per task → Worker → commit → mark `done` → re-render `plan.md` + persist `RunState`. Decide PR trigger by `prPerTask || isLastTaskInGroup`. Keep worktree acquisition + `StateWriteAfterSuccess` guard intact.
5. Resume: skip tasks already `done`.

## Tests
- Unit `plan-markdown.test.ts`: parse↔render round-trip incl. complexity tags + `[x]` state; tolerates missing complexity.
- Unit `schema.test.ts`: `Task` validation; legacy `string[]` coercion.
- Unit `work-loop.test.ts`: per-task loop marks tasks done in order; PR opens on last task (group mode) and each task (`prPerTask`); resume skips done tasks.
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- A multi-task group executes task-by-task, `plan.md` shows `[x]` per completed task, and PR-open timing respects `--pr-per-task`. Resume continues from the first undone task.

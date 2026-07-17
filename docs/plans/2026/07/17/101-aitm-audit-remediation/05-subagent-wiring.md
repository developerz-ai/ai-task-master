# 05 — Subagent wiring integrity

> Part of [`overview.md`](overview.md). Depends on: none. Coordinate the prompt envelope with `01` (untrusted-data framing).

Every path that spawns a subagent must carry the same contract blocks. One path also silently drops config the editing needs, and one path reports edits that never happened.

> **Design note (owner-clarified):** aitm does **not** verify before every commit — that's intentional, it's what makes it faster than a per-commit-gated tool; CI is the safety net after the PR, and self-review runs **before the PR opens**, not per-commit. So the fix below is **not** "add a verify gate to every commit." The invariant to protect is: the pre-PR verify/self-review + the Worker's `formatCommand`/`providerOptions`/`timeout`/`onUsage` config are carried on **whichever path does the editing** — don't let the orchestrator-tool path silently run a differently-configured Worker. Do not reintroduce per-commit verification.

## Files to change
| `file:line` | Problem | Fix |
| --- | --- | --- |
| `orchestrator/subagent-tools.ts:98,120,143` | Planner/Worker/Reviewer tool wrappers build the system prompt by naive `styleContents + *_SYSTEM_PREFIX` concat, bypassing `buildRolePrompt` (`role-prompt.ts`) — the single place the mandatory contract blocks (faithful-reporting, autonomy), the `<env>` block, and the step-budget reminder are injected. On the orchestrator-tool path subagents run **without any of them**. | Route all three through `buildRolePrompt`; the invariant then holds on every path (and the test the comment claims exists can enforce it). |
| `orchestrator/subagent-tools.ts:111-132` (`makeWorkerTool`) | `WorkerToolDeps` silently drops the Worker's `formatCommand`, `providerOptions` (web_search), `timeout`, `onUsage` → the orchestrator-tool Worker runs with a **different, degraded config** than the direct path (no format, no web_search, no usage accounting, no timeout). Not a missing verify gate (per-commit verify is intentionally off) — a config-drift bug between two spawn paths. | Thread `formatCommand`/`providerOptions`/`timeout`/`onUsage` through `WorkerToolDeps` so both paths configure the Worker identically. Leave per-commit verify off by design. |
| `subagents/worker.ts:483-486` (`runEditor`) | A `FileChange` is derived from the model's **first line of text**; no check the file actually changed on disk. A model that narrates without calling `writeFile`/`editFile` still yields a `changes` entry → poisons the PR body and can leave `stageAndCommit` with nothing to commit (throw). | Verify the path actually changed (stat / `git status`) before recording; treat "no diff" as an editor failure. |

## Steps
1. Make `buildRolePrompt` the sole prompt builder; delete the ad-hoc concat in `subagent-tools`. Fold in the untrusted-data envelope from `01`.
2. Extend `WorkerToolDeps` to carry `formatCommand`/`providerOptions`/`timeout`/`onUsage`; wire them in `makeWorkerTool` so both spawn paths configure the Worker identically. Leave per-commit verify **off** (by design).
3. `runEditor`: confirm on-disk change before emitting a `FileChange`; fail the editor on no-op.

## Tests
- Unit: a subagent built via the orchestrator-tool path contains the contract/`<env>`/step-budget blocks (assert on the composed prompt). `makeWorkerTool`-built Worker receives the same `formatCommand`/`providerOptions`/`timeout`/`onUsage` as the direct path (config parity). `runEditor` with a narrate-only model (no file write) records **no** change and fails, rather than reporting a phantom edit.
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- Contract + `<env>` + step-budget blocks are present on **every** subagent-spawn path.
- Both spawn paths configure the Worker identically (no silent config drift); per-commit verify stays off by design.
- `changes` reflects real disk edits only.

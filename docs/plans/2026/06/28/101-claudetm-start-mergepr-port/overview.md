# Port claudetm `start` / `merge-pr` behavior to aitm

## Goal
Bring claude-task-master's strongest behaviors into `aitm`: distilled coding-style planning, task/subtask-driven PR execution, the `.ai-task-master` lifecycle state, and the CI-wait → download-failed-logs+comments → fix → re-poll → merge loop. Close the gaps between aitm's existing scaffolding and claudetm's proven workflow — **without** porting claudetm's out-of-scope features.

## Context
- **Source**: `../claude-task-master` (Python). Reference behavior only — do not copy code. Key files: `src/claude_task_master/cli_commands/{workflow.py,fix_pr.py,ci_helpers.py,fix_session.py}`, `core/{orchestrator.py,task_runner.py,planner.py,pr_context.py,state.py,workflow_stages.py}`, `github/client_pr.py`.
- **Target**: `packages/aitm` (TypeScript, Bun/Node≥20/Deno≥1.40). Stack: `ai` package `experimental_Agent` subagents-as-tools; OpenRouter-only via `Credentials`; `gh` CLI via `GitHubClient`.
- **aitm already has** (do not rebuild — extend): `GitHubClient` with `waitForChecks`/`getFailedCiLogs`/`listUnresolvedThreads`/`replyToThread`/`resolveThread`/`mergePr` (`src/github/github-client.ts`); `PrContextStore` (`src/state/pr-context-store.ts`); `StateStore` + `RunState`/`PrGroup` (`src/state/{state-store.ts,schema.ts}`); `WorkLoop` (`src/loop/work-loop.ts`); `Planner`/`Worker`/`Reviewer` (`src/subagents/*`); `AgentConfigDetector` (`src/agent-config/`); CLI `start`/`merge-pr` (`src/cli/{cli.ts,commands.ts,args.ts}`).
- **State dir**: aitm uses `.ai-task-master/` (claudetm uses `.claude-task-master/`). Keep aitm's name. `debugging/pr/<pr>/{ci,comments}/` layout is shared.
- Reference patterns to follow: `src/subagents/planner.ts:60` (agent creation), `src/github/github-client.ts:161` (CI wait backoff), `src/loop/work-loop.ts:135` (per-group execution).

## The real gaps (what this plan delivers)
1. **Coding-style distillation** — claudetm generates a cached `coding-style.md` from CLAUDE.md + test patterns + config, then injects the *distilled* digest into every prompt. aitm injects raw CLAUDE.md. → `01`.
2. **Task/subtask execution** — claudetm parses `[SIMPLE|NORMAL|COMPLEX]` checkbox tasks per PR group, executes per-task, marks `[x]` complete, supports PR-per-task vs PR-per-group. aitm's `PrGroup.tasks` is a flat `string[]` with no per-task state. → `02`.
3. **PR-lifecycle stage machine** — claudetm persists `workflow_stage` (`working→pr_created→waiting_ci→ci_failed→waiting_reviews→addressing_reviews→ready_to_merge→merged`) so a run resumes mid-lifecycle. aitm's WorkLoop does CI-wait→review→merge inline, no granular persisted stage. → `03`.
4. **CI-fix loop** — claudetm downloads failed CI logs + review comments to `debugging/`, feeds them to a fix session, rebases + force-pushes, re-polls, loops to a cap. aitm has the pieces (`getFailedCiLogs`, `PrContextStore`, `Reviewer`) but `waitForChecks` just throws `CiFailed` — the loop isn't wired. → `04`.
5. **`merge-pr` full loop** — claudetm `merge-pr <n>` is a standalone wait→fix→comments→merge loop (default 30 iterations). aitm `runMergePr` is a thinner take-over+merge. Wire the same fix loop in. → `04`.

## Plan files (execute in order)
1. [`01-coding-style-distillation.md`](01-coding-style-distillation.md) — generate + cache distilled `coding-style.md`; inject digest into subagent prompts.
2. [`02-task-subtask-model.md`](02-task-subtask-model.md) — `Task`/subtask shape on `PrGroup`, plan.md checkbox parse/render, per-task execution + PR-per-task option.
3. [`03-pr-lifecycle-stages.md`](03-pr-lifecycle-stages.md) — persisted `workflowStage` on `RunState`; stage handlers so runs resume mid-PR.
4. [`04-ci-fix-loop.md`](04-ci-fix-loop.md) — CI-fail → download logs+comments → fix session → rebase/force-push → re-poll loop, in both WorkLoop and `merge-pr` (iteration cap).
5. [`05-tests.md`](05-tests.md) — unit + integration coverage for every new module/seam.

## Done when
- `aitm start "<goal>"` plans with a distilled coding-style digest, executes each PR group task-by-task (marking `plan.md` checkboxes), and on CI failure downloads logs+comments, runs a fix session, rebases/force-pushes, re-polls, and merges when green — resumable at any stage.
- `aitm merge-pr <n>` runs the wait→fix→comments→merge loop to completion with an iteration cap.
- All new modules have paired `*.test.ts`; integration tests cover the CI-fix loop against a temp git repo + stubbed `gh`. `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint` all green.

## Risks / open questions
- **Scope discipline**: claudetm ships webhooks, a mailbox/inbox, budget tracking, and a verification/release phase. Webhooks + mailbox are **out of scope per `CLAUDE.md`** — do NOT port. Budget/verification/release are optional and excluded from v1 of this plan unless the user asks.
- **Stage machine vs current inline WorkLoop**: slice `03` refactors `WorkLoop.runGroup` (`work-loop.ts:135`) to drive stages. Keep the `StateWriteAfterSuccess` guard (`work-loop.ts:94`) — losing a real PR-open/merge outcome to a failed state write is the main hazard.
- **Concurrency × stages**: aitm runs groups concurrently (DAG); claudetm is single-stream. Persisted per-group stage must be keyed by group id, not a single global `workflowStage`. Decide: per-group stage field on `PrGroup` (preferred) vs global. Plan assumes **per-group**.
- **Force-push safety**: always `git push --force-with-lease`, rebase onto `origin/<base>` before push (claudetm `fix_pr.py`).
- **Model routing by complexity**: claudetm forces its strongest model for CI-fix/review sessions. aitm maps role→capability in `Credentials` (`credentials.ts:13`); reuse that (worker→coding, reviewer→smart) rather than hardcoding model ids.

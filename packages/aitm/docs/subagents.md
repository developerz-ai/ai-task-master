# Subagents

`aitm` follows the Vercel AI SDK subagents pattern: an agent calls another agent as a tool. See https://ai-sdk.dev/docs/agents/subagents. The payoff — isolated context windows, focused system prompts, and natural parallelism.

## Composition

`Orchestrator` is the top-level agent. Its tool surface:

- The three subagents below.
- Low-level tools: `fs.read`, `fs.write`, `bash`, `GitHubClient` methods.

Subagents never call each other. Only `Orchestrator` composes them — the dependency graph stays a tree.

## Roster

| Subagent | Single responsibility | Tools it gets | Output contract |
| --- | --- | --- | --- |
| `Planner` | Turn goal plus repo survey into an ordered list of **PR groups**, each containing tasks. | Read-only subset: `readFile` (offset/limit), `grep`, `glob`. | `PrGroup[]` (Zod schema). Capped by `options.maxPrs`. |
| `Worker` | Implement one PR group on a dedicated branch (commits + branch); the Orchestrator opens the PR. | `readFile`, `writeFile`, `editFile`, `multiEdit`, `grep`, `glob`, `bash`. | Branch + draft commit message, or `blocked` reason. |
| `Reviewer` | Address PR review comments, push fixes, resolve threads. | The Worker's full set plus a `github` thread tool (`GitHubClient` GraphQL). | Resolution report per comment. |

The FS/edit/search/shell tools are the Claude-Code-style surface from `@developerz.ai/ai-claude-compat`, scoped to the active worktree. When an MCP server supplies some of them, the rest are partial-filled from the local set so a bare `aitm start` (no `mcpServers`) still works.

## The `explore` fan-out (issue #126)

The Planner and the Worker's manifest pass also get a read-only **`explore`** tool. Calling it spawns a fresh, bounded, fast-tier child that surveys the repo with the read-only trio (`readFile`/`grep`/`glob`) and returns a single self-contained conclusion. The child ingests the raw file text; the parent's context holds only the answer — so a survey phase no longer re-sends file dumps on every step of its own conversation (the pressure `#102`'s compaction repairs after the fact). Independent `explore` calls issued in one assistant turn run in parallel (AI SDK parallel tool execution).

Contract (built on compat's `makeAgentTool`):

- **Fresh context, self-contained prompt.** The child shares no parent conversation; the tool description states the prompt must carry every detail the child needs.
- **Read-only by allowlist.** `makeAgentTool` refuses (typed construction error) any child toolset key outside the explicit allowlist — the `explore` callers pass `['readFile', 'grep', 'glob']`. No recursion: the child toolset can never contain `explore` itself.
- **Bounded + failure-tolerant.** Default 15-step child cap and a 4000-char output cap (truncated with a marker). A step-cap exhaustion returns the last text (or a no-conclusion line); a child provider error is caught and returned as an error line — never thrown into the parent step. The parent's per-step deadline (`#129`) propagates into the child via the execute `abortSignal`.
- **Adapter-local glue, never MCP.** The child model is `credentials.modelForCapability('fast')` and its read tools are `resolveInside`-confined to the invoking agent's worktree — constructed in the run-loop adapter (same precedent as the Reviewer's `github` slot), never sourced from a server. Mounted as a runtime-only extra so the core `WorkerTools`/`PlannerTools` types are unchanged; records built without it (take-over flow, editors, test stubs) behave exactly as before. Editors strip it before their per-file fanout — editors never nest surveys.

## SRP

Each subagent owns exactly one phase of the lifecycle. Planning, building, and reviewing are separate concerns with separate prompts and separate tool grants.

## Context isolation

Subagent system prompts are assembled from `CLAUDE.md` or `AGENTS.md` plus a role-specific prefix plus an `<env>` block (`envBlock` from `@developerz.ai/ai-claude-compat`: worktree cwd, platform, OS version, runtime, date). The `<env>` block is composed at the wiring site via `composeSystemPrompt` because cwd is per-worktree. `AgentConfigDetector` decides which config file to read — it drives **coding-style** only. Provider is always OpenRouter; the per-role model id comes from `ConfigLoader` (`models.planner`, `models.worker`, `models.reviewer`), so each subagent can run on a different OpenRouter-routed model.

## Schemas

Inputs and outputs of every subagent are Zod-validated. Handoffs between `Orchestrator` and subagents are predictable, typed, and refuse malformed payloads at the boundary.

## Failure surface

Each subagent returns a discriminated-union result — `ok`, `blocked`, `needs-input`, `error`. `Orchestrator` interprets the variant and decides retry, escalate, or mark blocked in `StateStore`.

## SRP + tested

Each subagent is a pure factory: `(model, tools, systemPrompt) -> Agent`. The factory is unit-tested; the integration behavior is covered by end-to-end tests in `test/integration/`. No subagent ships without both.

## See also

- `./commands/start.md`
- `./commands/merge-pr.md`
- `./task-groups.md`
- `./coding-style.md`
- `./config.md`
- `./architecture.md`
- `./agent-config-detection.md`

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
| `Planner` | Turn goal plus repo survey into an ordered list of **PR groups**, each containing tasks. | Read-only FS, grep, glob. | `PrGroup[]` (Zod schema). Capped by `options.maxPrs`. |
| `Worker` | Implement one PR group end-to-end on a dedicated branch and open the PR. | FS read/write, bash, `GitHubClient`. | PR number or `blocked` reason. |
| `Reviewer` | Address PR review comments, push fixes, resolve threads. | FS read/write, bash, `GitHubClient` GraphQL. | Resolution report per comment. |

## SRP

Each subagent owns exactly one phase of the lifecycle. Planning, building, and reviewing are separate concerns with separate prompts and separate tool grants.

## Context isolation

Subagent system prompts are assembled from `CLAUDE.md` or `AGENTS.md` plus a role-specific prefix. `AgentConfigDetector` decides which file to read — it drives **coding-style** only. Provider is always OpenRouter; the per-role model id comes from `ConfigLoader` (`models.planner`, `models.worker`, `models.reviewer`), so each subagent can run on a different OpenRouter-routed model.

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

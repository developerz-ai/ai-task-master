# CLAUDE.md

Instructions for Claude when editing `aitm` source. Not for end users.

## House style

- SOLID. One responsibility per module. If a file grows a second reason to change, split it.
- Every module ships with tests. SRP + tested is the bar — no test, no merge.
- No premature abstraction. Inline first, extract on the second real caller.
- No comments unless the WHY is non-obvious. Names carry intent.
- Conventional commits. No co-author trailers.

## Runtime stance

- Bun is the dev runtime — `bun run`, `bun test`, `bun.lockb`.
- Code must run unchanged on Bun, Node ≥ 20, and Deno ≥ 1.40. Treat Bun-only APIs as a portability bug.
- Use `node:fs/promises`, `node:child_process` / `execa`, web `fetch`. Avoid `Bun.file`, `Bun.$`, `Bun.spawn` in shipped code. They are fine in dev scripts and tests gated behind `if (process.versions.bun)`.
- Module system: ESM only. `"type": "module"` in `package.json`.

## TypeScript

- `strict: true`. No `any`, no `as unknown as`. Use `unknown` and narrow.
- `type` for data shapes. `interface` only when declaration merging is actually needed.
- Named exports only. No default exports.
- File names: kebab-case. Type names: PascalCase. Function names: camelCase.

## Provider

- Only **OpenRouter** (OpenAI-compatible) is used for inference. No Anthropic SDK, ever.
- `Credentials` reads `OPENROUTER_API_KEY` from env. No OAuth, no `~/.claude/.credentials.json`.
- The presence of `CLAUDE.md` in a target repo is a *coding-style signal*, not a provider signal — feed it to subagent system prompts.

## AI SDK

- `ai` package, `experimental_Agent` plus the subagents-as-tools pattern from https://ai-sdk.dev/docs/agents/subagents.
- `Orchestrator` is the top-level agent. `Planner`, `Worker`, `Reviewer` are exposed to it as tools.
- Provider wiring lives in one place (`Credentials`). Subagents take an injected model handle.

## Module map

| Module | Responsibility |
| --- | --- |
| `Credentials` | Read `OPENROUTER_API_KEY`, return a configured AI SDK model handle |
| `AgentConfigDetector` | Find `CLAUDE.md` or `AGENTS.md`, return coding-style payload |
| `StateStore` | Persist run state, plan, PR groups, current task, PR number |
| `Planner` | Subagent. Goal in, ordered PR groups (each a list of tasks) out |
| `Worker` | Subagent. One PR group in, commits and a PR out |
| `Reviewer` | Subagent. PR review comments in, follow-up commits out |
| `GitHubClient` | Thin wrapper over `gh` CLI for PR, CI status, review comments |
| `WorkLoop` | Drives Orchestrator group-by-group through the plan |
| `CLI` | `aitm start`, `aitm merge-pr`. Arg parsing and exit codes only |
| `Logger` | Structured logs to stderr, plain status to stdout |

## Testing

- Every module has a paired `*.test.ts`. No exceptions.
- Integration tests run against a real temp git repo and real `gh` against a sandbox account. They are the source of truth for behavior.
- Unit tests cover pure modules (`AgentConfigDetector`, `Credentials` resolution, plan parsing, PR-group sizing).
- No mocking of `gh` or the AI SDK in integration tests. Mock only at module boundaries in unit tests.
- Tests must pass under both `bun test` and `node --test` (or `vitest run` with a Node target) — runtime portability is enforced by CI.

## Out of scope for v1

Do not add, do not stub, do not leave TODOs for:

- Mailbox / inbox features
- MCP server
- Webhooks or any inbound HTTP
- Docker, devcontainers, or any containerization

If a change pulls in any of these, stop and surface it instead of implementing.

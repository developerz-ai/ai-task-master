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

## Branch protection & `--admin`

`main` on the `developerz-ai` repos requires **one approving review**, so `gh pr merge` on a solo-authored PR is refused with "the base branch policy prohibits the merge" even with every check green. Two consequences:

- **Running aitm here:** pass `--admin` (`aitm start … --admin`, `aitm merge-pr --pr N --admin`) or the run blocks on a finished, green PR it cannot land.
- **Merging by hand:** `gh pr merge <n> --squash --admin`.

`--admin` overrides the policy — it does not satisfy it. It never skips CI or ignores failing checks; those still route to the CI-fix loop. It does advance a CI *timeout* to the review stage rather than blocking.

## Tolerated check failures

Some status checks fail for reasons no commit can fix. `github/check-tolerance.ts` holds a whitelist of `{ check, description, reason, match }` rules; a failure matching one is treated as *skipped*, so `waitForChecks` neither reports it as failed nor loops on it. Built in: **CodeRabbit quota failures** — `match: 'contains'` on `rate limit` and `limit reached`, covering both wordings the service uses. A real verdict (`1 issue found`, `Review failed`) contains neither and still fails CI, as does the same message from any other check.

Add an exception by appending a rule (`match: 'contains'` when a service words one condition several ways), or without a release via `AITM_TOLERATED_CHECK_FAILURES="check=description;other=description"` — env rules are always exact. Mirrors `claude-task-master`'s `github/check_tolerance.py`.

## Testing

- Every module has a paired `*.test.ts`. Two narrow exemptions, applied consistently:
  - Pure re-export barrels with no logic of their own (only `export { ... } from './x.ts'` /
    `export type { ... } from './x.ts'`) — nothing to unit-test that isn't already covered by the
    re-exported module's own paired test. Example: `observability/step-progress.ts`.
  - Test-only support/fixture modules consumed exclusively by `*.test.ts` files (never imported from
    production code) — they're test infrastructure, not a module under test. Example:
    `loop/work-loop-test-support.ts`.
  Everything else — including small constant/helper files with real logic (e.g. a capping function) —
  ships a paired test.
- Integration tests run against a real temp git repo and real `gh` against a sandbox account. They are the source of truth for behavior.
- Unit tests cover pure modules (`AgentConfigDetector`, `Credentials` resolution, plan parsing, PR-group sizing).
- No mocking of `gh` or the AI SDK in integration tests. Mock only at module boundaries in unit tests.
- Tests must pass under both `bun test` and `node --test` (or `vitest run` with a Node target) locally before every commit. CI's `bun` job only runs install/lint/typecheck/typecheck:tests — `bun test` is deliberately omitted there (Bun's `node:test` shim mishandles our suite across files, oven-sh/bun#5090); the `node` job (`npm run test:node --workspaces`) and `integration` job are what CI actually runs and are authoritative for portability enforcement.

## Out of scope for v1

Do not add, do not stub, do not leave TODOs for:

- Mailbox / inbox features
- Exposing `aitm` itself as an MCP server — never. `aitm` is **only an MCP client**: it
  can connect to external MCP servers and consume their tools (`mcpServers` in config).
- Webhooks or any inbound HTTP — **exception:** loopback-only OAuth redirects per RFC 8252 (http://127.0.0.1:PORT or http://[::1]:PORT) for native app OAuth flows are permitted for MCP server authentication; remote inbound servers remain banned.
- Docker, devcontainers, or any containerization

If a change pulls in any of these, stop and surface it instead of implementing.

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.

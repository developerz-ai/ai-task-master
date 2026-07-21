# ai-task-master

`aitm` — an autonomous task orchestrator for real repositories. You give it a one-sentence
goal and it runs a Planner → Worker → Reviewer loop, splitting the goal into PR-sized task
groups, branching and committing, opening pull requests via the `gh` CLI, handling review
comments and CI, and auto-merging when CI is green. It serves developers who want long-running
agentic work to end in merged PRs rather than a chat transcript. It is the spiritual successor
to the deprecated `developerz-ai/claude-task-master`, rebuilt provider-agnostic on the Vercel
AI SDK + OpenRouter with a much smaller surface area.

- **Stack:** TypeScript (strict, ESM-only, named exports) in a Bun workspaces monorepo
  (`packages/*`). Bun is the dev runtime, but shipped code must also run unchanged on Node ≥ 20
  and Deno ≥ 1.40. Inference is OpenRouter-only (OpenAI-compatible) via the `ai` package
  (`experimental_Agent` + subagents-as-tools). Biome for lint/format; `bun test` plus a Node
  test target. Distributed as an npm CLI (`aitm start`, `aitm merge-pr`); see `PUBLISHING.md`.
- **Key commands:** `bun run build`, `bun run typecheck` (+ `typecheck:tests`), `bun test`,
  `bun run test:node`, `bun run lint` / `lint:fix`, `bun run format`.
- **Layout:**
  - `packages/` — the workspace packages holding the CLI and orchestration modules
    (Credentials, AgentConfigDetector, StateStore, Planner, Worker, Reviewer, GitHubClient,
    WorkLoop, CLI, Logger — see the module map in CLAUDE.md)
  - `docs/` — project documentation
  - `assets/` — logo and images
  - `PUBLISHING.md`, `VERIFICATION.md` — release and verification procedures
- **State as of 2026-07-21:** branch `main`; working tree was clean when this note was written.
  Note: CLAUDE.md asks for no co-author trailers on commits, but the commit adding this file was
  explicitly instructed to include one.

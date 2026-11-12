# developerz-ai/ai-task-master — packages/aitm

> Workspace brain — owned by this workspace's maintainers, then owned by
> its maintainers. Correct it in place; setup never overwrites a brain that exists.

The `aitm` CLI product (published as @developerz.ai/aitm) — goal in → Planner/Worker/Reviewer loop → merged PRs, on the Vercel AI SDK over OpenRouter-compatible providers.

The gate is the repo root’s: `bin/check` (see the root `CLAUDE.md`).

## Structure

- `src/` — 23 single-responsibility dirs (see root CLAUDE.md module map): `cli/`, `loop/`, `subagents/`, `orchestrator/`, `state/`, `workspace/`, `github/` (+ `check-tolerance.ts` whitelist), `config/`+`credentials/`+`openrouter/` (fixed three-way provider split), `plan/`, `mcp/` (client only), `compaction/`, `agent-config/`, `logger/`, `observability/`, `tools/`, `domain/`, `fs/`, `serialization/`, `composition/`, `benchmark/`, `testing/` (test-only, imported exclusively by `*.test.ts`).
- `test/integration/` — real-git e2e suite (`start-flow`, `ci-fix-loop`, `resume-flow`, `crash-durability`, `hostile-repo`, `e2e-smoke` …); `e2e-smoke` self-skips without secrets.
- `docs/` — product docs (architecture, commands/, providers, config, state, runtime …) incl. vendored AI SDK reference under `docs/vendor/` (excluded from lint).
- `scripts/` — `debug-start.ts` / `debug-merge-pr.ts` in-process debug harness, `smoke-e2e.ts`, `benchmark.ts`.
- Depends on `@developerz.ai/ai-claude-compat` pinned to an EXACT version.

## Conventions

- Package scripts: `test:node` = `node --test --import tsx "src/**/*.test.ts"` (authoritative); `test` = `AITM_INSTANT_SLEEP=1 bun test` (passes locally, deliberately absent from CI); `test:integration` runs `test/**/*.test.ts` against real git.
- `typecheck` (src product code) and `typecheck:tests` (src test files + the `test/` integration suite) are separate tsc projects — both must pass.
- Integration tests mock nothing — real temp git repos, real `gh` against a sandbox account; mock only at module boundaries in unit tests.
- Never add `bun test` to CI — oven-sh/bun#5090 makes the node:test shim ordering-dependent across files.
- Dogfood changes via `bun packages/aitm/scripts/debug-start.ts` (throwaway repo, stops deterministically without a provider key, tears down on exit).
- State written to a target repo lives under `.ai-task-master/` — never write run state anywhere else.

---
description: Run the real-git integration suite for aitm locally and read its skip behavior. Use for integration tests, e2e-smoke, test:integration, real git, temp repo.
applies: [typescript, javascript, bun]
---

> House skill — established by dz-runner setup mode from this repo's own evidence, then owned by its maintainers. Correct it in place; setup never overwrites a skill that exists.

1. Install: `bun install` (or `npm install` for the node lane), then build the compat runtime entry: `npm run build -w @developerz.ai/ai-claude-compat` — the suite imports `@developerz.ai/ai-claude-compat` by package name and its only export (`dist/index.js`) is absent from a clean checkout.
2. Run the integration suite: `npm run test:integration -w @developerz.ai/aitm` — it drives real git worktrees/pools end-to-end against throwaway temp repos; budget ~20 min (CI's own timeout).
3. Unit-only fast pass first if debugging: `bun run test:node` (per workspace via the root filter script).
4. `e2e-smoke` self-skips without secrets — its skip is expected locally, not a failure.
5. `gh`-dependent tests need an authenticated `gh` CLI against a sandbox account; git-only tests run with plain git and no credentials.
6. CI reference: the `integration` job in `.github/workflows/ci.yml` runs `npm install`, then `build (compat runtime)` (`npm run build -w @developerz.ai/ai-claude-compat`), then the same `test:integration` target on Node 22.
fail -> "test() inside another test()" under `bun test` is the known node:test shim bug (oven-sh/bun#5090), not your change — run the suite under `node --test` instead.

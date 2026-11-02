---
description: Cut and publish a release of both workspace packages via OIDC trusted publishing. Use for version bump, release, publish, npm, lockstep versions.
applies: [typescript, javascript, bun]
---

> House skill — established by dz-runner setup mode from this repo's own evidence, then owned by its maintainers. Correct it in place; setup never overwrites a skill that exists.

1. Bump the version in BOTH `packages/aitm/package.json` and `packages/ai-claude-compat/package.json` — keep them in lockstep; `aitm` pins compat to an exact version.
2. Run `bun install` (updates lock metadata but NOT resolution — a version move is not a resolution change; `bun.lock` workspace version lines are allowed to lag).
3. Do NOT regenerate `bun.lock` in this PR — a lockfile resync is its own dependency-upgrade PR.
4. Commit with a conventional message (no co-author trailers).
5. Publish a GitHub Release, or trigger Actions → release → Run workflow (`release.yml`).
6. The workflow runs `bun install --frozen-lockfile`, `bun run build`, then `npm publish -w @developerz.ai/ai-claude-compat` BEFORE `npm publish -w @developerz.ai/aitm` — order is mandatory (exact-pin dependency).
7. Publish is OIDC trusted publishing (no NPM_TOKEN); it needs npm ≥ 11.5.1 — the workflow pins npm@11.5.2 because 11.6.x broke the provenance path.
8. First-ever version of a package is manual bootstrap by an org member (`npm login`, build, `npm publish -w … --access public`) — a trusted publisher can only attach to an existing package.
fail -> if `npm publish` dies on "Cannot find module 'sigstore'", the npm version regression hit: stop, do not bump the workflow pin without a task.

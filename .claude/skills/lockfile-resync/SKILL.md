---
description: Regenerate bun.lock for a dependency upgrade in its own PR without touching release version lines. Use for bun.lock, dependency upgrade, lockfile, resync, frozen-lockfile.
applies: [typescript, javascript, bun]
---

> House skill — owned by this repository's maintainers, and written from this repository's own evidence. Correct it in place; a skill that exists is never overwritten.

1. Work in a PR whose SUBJECT is the upgrade — never inside a release PR.
2. Delete `bun.lock` and run `bun install` to re-resolve; expect wide movement (measured on #327: 71 packages moved for 3 version-line changes).
3. Enumerate every moved package in the PR body.
4. Verify against the upgraded tree: `bun run typecheck`, `bun run typecheck:tests`, `bun run lint`, and `bun run test:node` — `bun install --frozen-lockfile` passing proves NOTHING here (it does not gate the workspace version field).
5. If `@biomejs/biome` moved, bump `biome.json` `$schema` in the same PR via `bunx @biomejs/biome migrate --write`.
6. Leave the workspace `version` lines in `bun.lock` alone — they are allowed to lag published versions and a guard asserting equality would be red after every release by construction.
7. Do not touch `bun.lock` in release/version-bump PRs — that boundary is what this procedure protects.
fail -> typescript@7 breaks madge's TS parser; CI runs `bunx madge@8.0.0` from an isolated install on purpose — never move madge into the workspace deps to fix it.

# developerz-ai/ai-task-master — packages/ai-claude-compat

> Workspace brain — owned by this workspace's maintainers, then owned by
> its maintainers. Correct it in place; setup never overwrites a brain that exists.

Claude-Code-style agent primitives for the Vercel AI SDK (@developerz.ai/ai-claude-compat), consumed by aitm via an exact version pin.

The gate is the repo root’s: `bin/check` (see the root `CLAUDE.md`).

## Structure

- Flat `src/`, one module per file, each with a paired `*.test.ts`: `agent-spawn` + `pool` (subagent-as-tool factory), `bash-tool`/`fs-tools`/`edit-tools`/`edit-replacers`/`search-tools` (Claude-Code-style tool surface), `env-block`/`prompt-blocks`/`system-reminder`, `skills-loader`/`agents-loader`/`memory-loader`/`skill-tool` + `frontmatter` (`.claude/` loading), `file-state`, `safe-path`/`gitignore`/`command-rules`/`tool-guards`/`tool-hooks`, `background-process`, `step-output-budget`, `tool-output-store`, `atomic-write`, `index.ts` barrel.
- Depends only on `ai`, `zod`, `execa` — no aitm dependency; aitm depends on IT, pinned exactly.

## Conventions

- Every module ships a paired `*.test.ts` in the same flat dir; `test:node` = `node --test --import tsx "src/**/*.test.ts"` (no bun `test` script in this package).
- `typecheck:tests` is its own tsconfig — a test drifting from package source must fail.
- This package publishes FIRST in a release (aitm pins it exactly) — version lines move in lockstep across both packages.
- No cross-package imports back from aitm and no re-export fix for the tracked `atomic-write.ts` duplication without an explicit task.
- Portability is the point of this package — nothing here may use `Bun.*` APIs; `node:fs/promises`, execa, web `fetch` only.

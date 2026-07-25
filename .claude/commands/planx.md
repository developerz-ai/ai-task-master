---
description: Write a concise, self-contained execution plan to docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/ for another AI to implement
argument-hint: [what you want done]
allowed-tools: Write, Read, Glob, Grep, Task, Bash
---

# /planx

Produce a concise plan another AI can execute with zero extra context. Plan only — no implementation, no code execution, no edits outside the plan dir.

## Goal
$ARGUMENTS

## Steps

1. **Resolve path.** Run `date +%Y`, `date +%m`, `date +%d`. Dir = `docs/plans/<YYYY>/<MM>/<DD>/`. `Glob docs/plans/<YYYY>/<MM>/<DD>/1*` → next number = highest existing `1NN-*` + 1, else `101`. Slug = kebab-case title, max 5 words. Final plan dir: `docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/`.

2. **Explore.** `Task` (subagent_type=Explore, thoroughness="very thorough"): existing patterns + files to touch (`file:line`), the right workspace (`packages/aitm` for `aitm`, `packages/ai-claude-compat` for the AI-SDK/Claude-compat layer), the module(s) under `packages/aitm/src/<module>/` from the module map (Credentials, AgentConfigDetector, StateStore, Planner, Worker, Reviewer, GitHubClient, WorkLoop, CLI, Logger), tests (unit `*.test.ts` paired with the module vs integration in `packages/aitm/test/integration/`), provider wiring in `Credentials`, gotchas. Prefer `codegraph_*` for structural lookups. Skip only for trivial asks.

3. **Write the plan as multiple files** in the plan dir — never one big `plan.md`. Always produce an `overview.md` index plus one `<NN>-<aspect>.md` per separable area (e.g. `01-module.md`, `02-subagent.md`, `03-cli.md`, `04-tests.md`). Split by area of work so each file is independently executable and stays short. Match the existing house style in `docs/plans/` — terse fragments, `file:line` refs, tables.

   **`overview.md`** — the map. Sections:

```markdown
# <Title>

## Goal
1-2 sentences: what + why.

## Context
- Stack facts the executor needs (Bun dev runtime; must run unchanged on Bun + Node ≥20 + Deno ≥1.40; ESM only; `ai` package with `ToolLoopAgent` + subagents-as-tools; OpenRouter-only inference via `Credentials`; `gh` CLI wrapper — only what's relevant).
- Reference patterns: `packages/aitm/src/<module>/<file>.ts:12` — follow this for Z.

## Plan files (execute in order)
1. [`01-<aspect>.md`](01-<aspect>.md) — one line: what it covers.
2. [`02-<aspect>.md`](02-<aspect>.md) — ...

## Done when
- Verifiable acceptance criteria spanning the whole feature.

## Risks / open questions
- Anything the executor must decide or watch.
```

   **Each `<NN>-<aspect>.md`** — one slice of work. Sections:

```markdown
# <NN> — <Aspect>

> Part of [`overview.md`](overview.md). Depends on: <NN-prior or "none">.

## Files to change
- `path:line` — what changes, why.

## Steps
1. Ordered, concrete actions. Reference `Class#method` / `file:line`, don't restate.

## Tests
- What to add/run. Unit: paired `*.test.ts` beside the module. Integration (real temp git repo + real `gh`): `packages/aitm/test/integration/`. Commands: `bun test`, `bun run typecheck`, `bun run lint`. Tests must also pass under `node --test` (`bun run test:node`).

## Done when
- Verifiable acceptance criteria for this slice.
```

4. **Write a `status.yml`** in the plan dir (alongside `overview.md`) — the live tracker for this plan. New plans start `not_started` / `0%`. Get `created_by` + `owner` from `git config user.name` (the person running /planx). Leave `worked_by` empty — the executor sets it to their own `git config user.name` when they pick the plan up, so a plan written by one person can be worked by another. Shape:

```yaml
plan: <1NN>-<slug>
title: <human title from overview.md>
status: not_started        # not_started | in_progress | blocked | complete | superseded
created_by: <git config user.name>   # who authored the plan
worked_by: ""              # who is executing it; empty = unclaimed; executor fills with their git user.name
owner: <git config user.name>
percent: 0                 # 0–100, overall completion
current_focus: ""          # where it's at right now / next slice to pick up
slices:                    # one row per <NN>-<aspect>.md slice
  - file: 01-<aspect>.md
    status: not_started      # not_started | in_progress | complete
    percent: 0
evidence: []               # commits/PRs proving progress, e.g. ["#324", "abc1234"]
notes: ""
last_updated: <YYYY-MM-DD>
```

   Keep `status.yml` machine-readable (valid YAML, the enums above). It's the one file in the plan dir that IS a tracker — the `.md` slices stay reference maps (no checkboxes there).

## Rules
- Compact English. Fragments over sentences. `file:line` and `Class#method` symbol refs over prose. Tables for structured data.
- Reference-only: point at code, don't paste it or re-explain it ("follow `x.ts` but ...").
- No checkboxes (`[ ]`). Plain bullets. The plan is a reference map, not a tracker.
- Multiple files always: `overview.md` + `<NN>-<aspect>.md` slices. Never a single `plan.md`.
- Self-contained: executor reads only `overview.md`, the slice it's on, and the files those cite.
- Respect `CLAUDE.md`: SOLID/SRP hard (one responsibility per module — split when a file grows a second reason to change). TypeScript `strict`, no `any`, no `as unknown as` — use `unknown` and narrow. Named exports only, no default exports. Files: kebab-case; types: PascalCase; functions: camelCase. ESM only. **Every module ships a paired `*.test.ts` — no test, no merge.** Tests pass under both `bun test` and `node --test`.
- Provider stance: **OpenRouter only** (OpenAI-compatible), no Anthropic SDK, ever. All inference flows through `Credentials` (`OPENROUTER_API_KEY`). `CLAUDE.md`/`AGENTS.md` in a target repo is a coding-style signal for subagent prompts, not a provider signal.
- Portability: code runs unchanged on Bun, Node ≥20, Deno ≥1.40. No `Bun.file`/`Bun.$`/`Bun.spawn` in shipped code (use `node:fs/promises`, `node:child_process`/`execa`, web `fetch`). Bun-only APIs are a portability bug.
- Out of scope (never plan, stub, or TODO): mailbox/inbox, exposing `aitm` as an MCP server (it is an MCP **client** only), webhooks/inbound HTTP, Docker/containers. If a change pulls any of these in, stop and surface it.
- Commits: conventional commits, no co-author trailers.

## Output
```
✓ docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/overview.md
  + 01-<aspect>.md, 02-<aspect>.md, … (one per area)
  + status.yml (tracker — status/owner/percent/current_focus)
Next: run an executor on overview.md.
```

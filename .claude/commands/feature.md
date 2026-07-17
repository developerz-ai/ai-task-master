---
description: End-to-end feature workflow for aitm — understand, explore, build (primitive-first, one module per responsibility), verify under Bun + Node, PR, merge, and (when asked) release to npm. Tracks in GitHub issues. Reads intent from the prompt.
argument-hint: <what you want built, plain language> [+ reference URL(s)]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, Skill, WebFetch, mcp__codegraph
---

# /feature

You are a **senior engineer on the aitm team**. Take a feature from plain-language idea to merged-and-green — and, when the ask calls for it, released to npm. `aitm` is a thin CLI that orchestrates AI coding agents (an `Orchestrator` driving `Planner`/`Worker`/`Reviewer` subagents-as-tools) to turn a goal into commits and PRs, inference through **OpenRouter only**, git/PR work through the `gh` CLI. Read [`CLAUDE.md`](../../CLAUDE.md) before designing anything.

## Request
$ARGUMENTS

**The prompt is the context — read the intent.** How autonomous to be, how big the scope, which modules, whether to confirm before merging, whether to cut a release: infer it from the words. "Do full work" / "just ship it" → run start-to-finish, decide everything yourself, merge on green, no check-ins — surface decisions in the issue and PR body instead of asking. A tentative or exploratory ask → clarify what's genuinely ambiguous and let the user review before you merge. Use judgment; don't make the user configure you. The flow below is the map, not a checklist to recite — skip what doesn't apply, and always stop for a true blocker (destructive/irreversible action, an irreversible npm publish, a policy violation from `CLAUDE.md`, an external dep you can't satisfy, anything in **Out of scope**).

## The flow

1. **Understand.** Restate the goal in a line. If the ask cites URLs (article, prior art), `WebFetch` them and extract the *pattern* (the mechanism), then translate it onto our stack — the AI SDK `experimental_Agent` + subagents-as-tools loop, provider wiring through `Credentials` (`OPENROUTER_API_KEY`, never an Anthropic SDK), run state in `StateStore`, the group-by-group drive in `WorkLoop`, and `gh` behind `GitHubClient`. This is a CLI, not a service — there is no UI to drive.

2. **Explore (parallel).** Fan out `Task` Explore agents (very thorough; `codegraph_explore` for structure) to map every affected surface: the right workspace (`packages/aitm` for the tool, `packages/ai-claude-compat` for the AI-SDK/Claude-compat layer) and the module(s) under `packages/aitm/src/<module>/` from the module map (`Credentials`, `AgentConfigDetector`, `StateStore`, `Planner`, `Worker`, `Reviewer`, `GitHubClient`, `WorkLoop`, `CLI`, `Logger`), the patterns to mirror (`file:line`), tests (unit `*.test.ts` paired beside the module vs integration in `packages/aitm/test/integration/`), and gotchas. Respect module boundaries — one responsibility per module. Produce a worklist grouped into PR-sized batches; log anything the survey couldn't cover.

3. **Track in GitHub (issues).** Find the existing issue or open one with `gh issue create`, wired to the right milestone/board. One sub-issue (or task) per PR-sized slice; each PR references its issue with a `Fixes #NNN` magic word so it auto-closes on merge. Keep a checklist on the parent issue; don't close the parent until every PR is merged.

4. **Build — primitive first, then fan out.** For a multi-surface change, never solve the same problem N ways: build one reusable primitive — a new module (or a helper on an existing one) with a single responsibility — and land it **with its first real caller** (no abstractions before consumers, inline first / extract on the second real caller). Every module ships a paired `*.test.ts` — **no test, no merge**. For genuinely independent PR-sized batches you may fan out **parallel worktree-isolated `Task` agents** (`isolation: worktree`), one per batch, each branching from fresh `main` and gating `bun run typecheck && bun run lint && bun test && bun run test:node` **in the foreground** (fresh worktrees need `bun install`). aitm is a small single-package tool, though — most features are **one branch, no fan-out**; reach for worktrees only when the batches truly don't touch each other.

5. **Verify.** Use the `/verify` skill as the green gate: `bun run typecheck`, `bun run lint`, and the suite under **both runtimes** — `bun test` *and* `bun run test:node` (portability is enforced by CI; code must run unchanged on Bun, Node ≥ 20, Deno ≥ 1.40, so a Bun-only API is a bug the Node run catches). Integration tests are the source of truth for behavior — run them against a real temp git repo and real `gh` (`bun run test:integration`). For a CLI-facing change, drive the real entry points (`aitm start`, `aitm merge-pr`) against a throwaway git repo + sandbox `gh` account and confirm the observable output (phase/step lines, commits, PR). A logic bug fixed here ships with a reproducing test alongside the code. Green gate under both runtimes + a clean CLI/integration verdict is the bar to merge.

6. **PR + merge sequentially.** Commit (Conventional Commit, scope = module, **no co-author trailers**, reference the issue), push, `gh pr create` (Summary + Test plan). Then merge PRs **one at a time**: wait for CI green (`ci.yml` — bun test + lint + the node portability run), address review comments (CodeRabbit included) and conflicts, then `gh pr merge --squash`. Never merge in parallel (it rebases and churns `main`). After each merge, rebase the next branch and re-run its gate. Never `--force`/`--no-verify`/skip hooks without permission.

7. **Release (npm — only when the ask calls for it).** aitm ships as the npm package `@developerz.ai/aitm` (bin `aitm`), published by `release.yml` via **OIDC trusted publishing** (no `NPM_TOKEN`, provenance automatic) — it fires on a **published GitHub Release**. There is no k8s/GitOps deploy and no `../infrastructure` to touch. Most feature PRs are *not* a release; cut one only when the user wants a version out. To release: bump the affected package version(s), merge, then publish a GitHub Release for the tag (`gh release create`) — an irreversible npm publish, so confirm intent first unless explicitly told to ship. Verify it landed: `npm view @developerz.ai/aitm version` shows the new version and the bin smoke-tests (`npx -y @developerz.ai/aitm@latest --help`).

8. **Watch + close.** The `Fixes #NNN` magic word auto-closes each child issue when its PR merges — verify each actually flipped and close any straggler by hand with a comment linking the merged PR. If you cut a release, confirm the published version and bin work (step 7). Once every child is closed (and any release confirmed), close the **parent issue** yourself. CI red on `main` or a broken published version → forward-fix on a branch; if a bad version reached npm, tell the user (publishes are irreversible — a fix is a new version, not an unpublish).

## Hard rules (from CLAUDE.md — non-negotiable)

**OpenRouter only** — OpenAI-compatible, no Anthropic SDK, ever; all inference flows through `Credentials` (`OPENROUTER_API_KEY`). A target repo's `CLAUDE.md`/`AGENTS.md` is a *coding-style* signal fed to subagent prompts, **not** a provider signal. **SOLID / SRP** — one responsibility per module; split when a file grows a second reason to change. **Every module ships a paired `*.test.ts` — no test, no merge.** No premature abstraction (inline first, extract on the second real caller). **Portability is a hard requirement** — runs unchanged on Bun, Node ≥ 20, Deno ≥ 1.40; use `node:fs/promises`, `node:child_process`/`execa`, web `fetch`; no `Bun.file`/`Bun.$`/`Bun.spawn` in shipped code (fine in dev scripts/tests gated behind `process.versions.bun`). **ESM only.** TS `strict`, no `any`, no `as unknown as` — use `unknown` and narrow. Named exports only, no default exports. Files kebab-case, types PascalCase, functions camelCase. **Conventional commits, no co-author trailers.** **Out of scope — never add, stub, or TODO** (stop and surface if a change pulls one in): mailbox/inbox; exposing `aitm` itself as an MCP server (it is an MCP **client** only); webhooks/inbound HTTP; Docker/devcontainers/any containerization.

## Output

```
Primitive:  <module/helper> @ packages/aitm/src/<module>/…  (PR #NNN, merged)   [sweeps only]
Surfaces:   <n> across <m> PRs → #… #…
Tests:      bun ✓ / node ✓   integration ✓   CLI smoke: <aitm start|merge-pr verdict>
Release:    @developerz.ai/aitm@<version> published  |  none this change
Issues:     #<parent> closed (<k> sub-issues)
```

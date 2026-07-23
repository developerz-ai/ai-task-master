# OpenCode-inspired agent tooling for aitm

## Goal
Steal three concrete mechanics from OpenCode (`sst/opencode`, cloned `~/workspace/opencode`) and a contrast tool (Aider, `~/workspace/aider`) to harden aitm's **file edits**, **bash**, and **subagent dispatch** — additive/surgical, no rewrite, matching CLAUDE.md. Each slice is one buildable module change with a verify command.

## Why these three (and not the rest)
Research read the real source of both tools. Most OpenCode ideas aitm *already has or has planned*:
- aitm already: two-phase Worker (manifest `submit` + bounded editor pool, `worker.ts:729`), `runPool` concurrency cap (`pool.ts`), read-before-edit + hash-staleness (`edit-tools.ts:96`, `fs-tools.ts:85`), cwd-persistent bash via epilogue (`bash-tool.ts:106`), deny/allow command rules (`command-rules.ts`), a read-only generic-dispatch seam (`explore` / `makeAgentTool`, `agent-spawn.ts`).
- Already claimed by **plan `2026/07/18/102-aitm-liveliness-tools-team-caching`** (sebi): oversized-output spill (`02`), background bash (`02`), streaming (`07`), editor-team fanout (`05`). **Do not re-propose these** — the slices below are orthogonal to plan 102 and complement it.

The three genuine, non-overlapping gaps, highest-leverage first:

| # | Mechanism | OpenCode does | aitm today | This plan adds |
| --- | --- | --- | --- | --- |
| 01 | **File edit** | 9-strategy fuzzy-replace cascade w/ disproportion guard (`edit.ts:682`) | exact `split/join` only — any near-miss throws `oldString not found` (`edit-tools.ts:124`) | fuzzy **fallback** ladder after exact fails |
| 02 | **Bash** | timeout → `<shell_metadata>` "retry with a larger timeout" (`shell.ts:562`) | timeout SIGKILLs, model gets a bare `ExecaError` — can't tell timeout from failure (`bash-tool.ts:204`) | typed `timedOut` + actionable notice |
| 03 | **Subagent dispatch** | child toolset derived by allowlist + explicit denies + no-recursion (`task.ts:143`, `subagent-permissions.ts`) | editor leaf toolset stripped by hardcoded destructure denylist (`worker.ts:574`) | declarative allowlist + transitive depth guard |

## Context
- Stack (CLAUDE.md): Bun dev; must run unchanged on Node ≥20 / Deno ≥1.40 (no `Bun.*` in shipped code); ESM only; strict TS, no `any`, named exports, kebab-case files; `ai` package `ToolLoopAgent` + subagents-as-tools; OpenRouter only; every module ships a paired `*.test.ts`; tests pass under `bun test` AND `node --test`. No worktrees — single shared checkout. Out of scope (hard): MCP-server, webhooks, Docker.
- Both engines live in **`packages/ai-claude-compat/src`** (the Claude-Code-style tool surface) — slices 01 & 02 change compat; slice 03 changes compat + `packages/aitm/src/subagents/worker.ts`.
- OpenCode reference (read-only, cite only): `~/workspace/opencode/packages/opencode/src/tool/{edit,shell,task}.ts`, `src/agent/subagent-permissions.ts`. Aider contrast: `~/workspace/aider` (whole-file / unified-diff edit formats — see slice 01 §Contrast).
- The failure surface these attack is aitm's own: `EMPTY_MANIFEST_REASON` (`worker.ts:242`), `editorNoChangeReason` / phantom-edit blocks (`worker.ts:426`), `appliedPhantomReason` (`worker.ts:439`) — a leaf that *narrates* an edit or emits a near-miss `oldString` fails the whole PR group and is misdiagnosed as "model too weak".

## Plan files (execute in order; all independent)
1. [`01-fuzzy-edit-fallback.md`](01-fuzzy-edit-fallback.md) — **highest leverage.** Port OpenCode's replacer cascade as an exact-first *fallback* in `applyEdit`; keep aitm's staleness/uniqueness contracts.
2. [`02-bash-timeout-notice.md`](02-bash-timeout-notice.md) — surface a killed-on-timeout command as a typed, actionable result instead of a bare error.
3. [`03-editor-toolset-scoping.md`](03-editor-toolset-scoping.md) — replace the ad-hoc editor tool-strip with an allowlist; add a transitive subagent-depth guard.

## Done when
- A leaf whose `oldString` differs only by leading whitespace/indentation now lands the edit (was: whole-group `blocked`), guarded so a wildly-oversized fuzzy match still refuses.
- A bash command killed at its timeout returns `timedOut: true` and a notice naming the ceiling + retry hint; a normal non-zero exit does not.
- The editor leaf toolset is derived from an explicit allowlist (a newly-mounted runtime tool is excluded by default, not by remembering to destructure it); behavior byte-identical for today's tool set.
- All gates green on both runtimes: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`. Every touched module keeps its paired `*.test.ts`.

## Risks / open questions
- Slice 01 is the only behavior-widening change: fuzzy matching can mis-target. Mitigations are load-bearing — exact match always wins, fuzzy runs only on 0 exact hits, every fuzzy hit re-checks uniqueness + `isDisproportionateMatch`, and the existing numbered-snippet self-verify already rides the result. Ship the exact-match path byte-identical; only the *throw* branch gains fallbacks.
- Relationship to plan 102: no file overlap — 01/02 touch `edit-tools.ts` / `bash-tool.ts` logic that 102 does not; 03 touches `worker.ts:574` (`editorToolSet`), which 102 §05 leaves alone. If 102's spill store lands first, slice 02's notice composes with it (spill handles *size*, this handles *termination cause*).

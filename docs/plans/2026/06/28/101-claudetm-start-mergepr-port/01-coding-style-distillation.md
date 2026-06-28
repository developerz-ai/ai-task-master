# 01 — Coding-style distillation

> Part of [`overview.md`](overview.md). Depends on: none.

Claudetm distills a cached `coding-style.md` (workflow, code style, **testing paths/commands/example files**, project-specific rules) from CLAUDE.md + test globs + config, then injects that *digest* into every planning and work prompt. aitm currently injects raw CLAUDE.md contents (`AgentConfigDetector` → orchestrator system prefix). Add the distillation step; keep raw contents as the distiller's input.

Source ref: `core/planner.py:18` (`ensure_coding_style`), `core/prompts_coding_style.py:18` (prompt + `CODING_STYLE_COMPLETE` marker), `core/state_file_ops.py:138` (load/cache).

## Files to change
- `src/agent-config/coding-style.ts` — **new**. `StyleDistiller`: input `AgentConfig` (+ repoRoot), output a compact markdown digest. One responsibility: turn raw style signals into a digest.
- `src/agent-config/coding-style.test.ts` — **new** (see `05`).
- `src/state/state-store.ts:10` — add `coding-style.md` to the managed file set; add `writeCodingStyle(md)` / `readCodingStyle()` (mirror `writeContext`/`readContext` at `state-store.ts:79`).
- `src/subagents/factory.ts` / `composeSystemPrompt` (used by `planner.ts:43`, `worker.ts:114`, `reviewer.ts:78`) — feed the digest as the style prefix instead of, or in addition to, raw `AgentConfig.contents`.
- `src/cli/commands.ts:135` (`runStart`) — after detecting `AgentConfig`, distill once and cache to state dir; reuse cache on resume.

## Steps
1. Define `StyleDistiller` with a `distill(input): Promise<string>` method. Input: `{ config: AgentConfig | null, repoRoot: string }`. It runs a one-shot LLM call (model via `Credentials.modelFor('planner')` — smart capability) with a prompt mirroring `prompts_coding_style.py`: analyze CLAUDE.md/AGENTS.md/CONTRIBUTING + test file globs (`**/*.test.ts`, `test/integration/**`) + config (`biome.json`, `tsconfig*.json`, `package.json` scripts). Output sections: Workflow, Code Style, Testing (paths/naming/commands/example files — mark CRITICAL), Project-Specific.
2. Cache: `runStart` calls `StateStore.readCodingStyle()`; if absent, `distill()` then `writeCodingStyle()`. Resume reuses the cached digest (claudetm regenerates only if missing).
3. Inject: replace the raw-contents prefix in `composeSystemPrompt` with the digest. If distillation fails or no `AgentConfig` exists, fall back to raw `AgentConfig.contents` (or empty) — never block the run on style.
4. Keep `AgentConfigDetector` unchanged; it remains the raw-signal source. Distiller is a separate module (SRP).

## Tests
- Unit `coding-style.test.ts`: stub model (`MockLanguageModelV3` from `ai/test`), assert prompt includes CLAUDE.md contents + test globs; assert digest passed through; assert fallback-to-raw on model error.
- Unit `state-store.test.ts`: `writeCodingStyle`/`readCodingStyle` round-trip; `readCodingStyle` returns null on ENOENT (mirror existing context test).
- Commands: `bun test`, `bun run typecheck`, `bun run lint`, `bun run test:node`.

## Done when
- `aitm start` produces `.ai-task-master/coding-style.md` on first run, reuses it on resume, and subagent system prompts carry the digest (verify via planner/worker prompt assembly test).
- No regression: runs with no CLAUDE.md still work (empty/raw fallback).

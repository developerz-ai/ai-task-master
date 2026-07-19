# 02 — Tool output spill, background bash, loop guards

> Part of [`overview.md`](overview.md). Depends on: none.
> Steals: opencode `tool/truncate.ts` (spill-to-file + paging hint, 7-day retention), Kimi `ToolResultBuilder` + background `output_path`, opencode doom-loop guard (`processor.ts:356-379`) and tool-call repair (`llm.ts:296-312`), Claude Code save-to-file behavior.

## Files to change
- New: `packages/ai-claude-compat/src/tool-output-store.ts` + test — central spill service.
- `packages/ai-claude-compat/src/bash-tool.ts:85,121-130` — route overflow through the store instead of destructive head/tail.
- `packages/ai-claude-compat/src/search-tools.ts:163-166` — same for grep/glob truncation notices.
- `packages/ai-claude-compat/src/fs-tools.ts:121-146` — readFile over-window notice includes `offset` continuation hint (already windowed; just improve the notice).
- `packages/ai-claude-compat/src/background-process.ts` — wire into aitm.
- `packages/aitm/src/loop/run-loop-adapter.ts:302,310-311` — inject `ProcessManager` into `bashInit`; mount `bashOutput`/`killBash` tools for worker/reviewer.
- New: `packages/ai-claude-compat/src/tool-guards.ts` + test — repeat-call dedup/doom-loop reminder.

## Steps
1. **`ToolOutputStore`**: `save(toolName, content) → {path, bytes, lines}` writing under `<stateDir>/tool-output/<ts>-<tool>-<n>.txt`; `cleanup(maxAgeDays=7)` called once per run start. Constructor takes the dir (aitm passes `.ai-task-master/tool-output/`); pure `node:fs/promises`.
2. **Bash overflow**: keep `MAX_BASH_OUTPUT_CHARS=30_000` in-context cap, but on overflow spill the FULL stream to the store and append (opencode `truncate.ts:129-137` wording): `[output truncated: N lines omitted. Full output: <path> — page it with readFile(offset/limit) or grep]`. Same treatment in `multiBash`.
3. **Grep/glob overflow**: truncation notice gains the saved-file path when results exceeded caps (`DEFAULT_MAX_RESULTS=200`, `GLOB_MAX_FILES=2000`).
4. **Aggregate step budget**: in the tool wrapper layer (where `toModelOutput` is built), track per-step total chars; once a step's combined tool output exceeds 120k chars, force spill mode for remaining results in that step (prevents N×cap context floods noted in the map, §2).
5. **Background bash wiring**: `run_in_background: true` currently degrades to foreground because aitm never injects a `ProcessManager` — construct one per run in `run-loop-adapter.ts` (`localEditTools` init), mount `bashOutput`/`killBash`, and on run end kill leftovers. Background completion returns tail + `output_path` (Kimi `background/__init__.py:75-97` shape).
6. **Doom-loop guard** (`tool-guards.ts`): hash (toolName, canonical input) per conversation; identical repeat ≥3 → prepend escalating reminder to the tool result; ≥8 → return error result instructing a different approach (Kimi `toolset.py:371-423` escalation, no permission system to fall back on).
7. **Tool-call repair**: on unknown tool name, try lowercase/known-alias match before failing; else return a structured "unknown tool, available: […]" error result instead of throwing (opencode `llm.ts:296-312`). Lives beside the guard in compat.
8. **Multi-read decision**: do NOT add a `multiRead` tool — parallel tool calls already cover it (provider `parallelToolCalls:true`, `worker.ts:527-531`). Instead strengthen `readFile`/`grep` tool descriptions to say "batch independent reads as parallel calls in one step". Document the decision in the PR body.

## Tests
- `tool-output-store.test.ts`: save/cleanup/retention; path shape.
- `bash-tool.test.ts`: overflow → file exists with full content, model output has path + hint; background path returns `output_path`; killBash reaps.
- `tool-guards.test.ts`: dedup escalation ladder; repair aliasing.
- Integration (`packages/aitm/test/integration/`): worker in temp repo runs a command producing 100k output → follow-up `readFile` of the spill path succeeds (real repo, no LLM — drive tools directly).
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- No tool output is destructively lost above caps; spill files are pageable and cleaned after 7 days; `run_in_background` actually backgrounds; repeated identical calls get escalating pushback.

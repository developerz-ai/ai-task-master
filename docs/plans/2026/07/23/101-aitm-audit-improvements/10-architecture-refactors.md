# 10 — Architecture refactors

> Part of [`overview.md`](overview.md). Depends on: 01-09 (moves code they touch — do last).
> Findings: [`findings/08-architecture-sweep.md`](findings/08-architecture-sweep.md) (all), plus SRP items from [`findings/01-loop.md`](findings/01-loop.md), [`findings/02-subagents-orchestrator.md`](findings/02-subagents-orchestrator.md), [`findings/06-observability-logger-compaction-plan-tools.md`](findings/06-observability-logger-compaction-plan-tools.md).

Every dependency cycle found is a shared-TYPE cycle, not a logic cycle — two moves dissolve almost all of them.

## Steps (ordered)
1. **Extract leaf `src/domain/`**: `PrGroup`, `Task`, `TaskComplexity`, `Role`, `WorkerDelivery`, tool I/O types. Dissolves state↔plan, state↔subagents, tools↔subagents, config↔credentials↔mcp cycles (findings/08 §2). Pure type moves; no behavior change.
2. **One composition root**: new `src/composition/` takes the wiring halves of `cli/commands.ts` (1307 LOC — constructs 8 services + `defaultRunLoop`) and `loop/run-loop-adapter.ts` (2049 LOC, imports 17/19 dirs). `RunLoopInput`/`RunMergeFlowInput` move out of `cli/` — kills the cli↔loop cycle. CLI returns to "arg parsing and exit codes only"; presentation helpers → `cli/format.ts`.
3. **Hoist default constants** into config-adjacent leaves (`DEFAULT_MAX_CI_FIX_ATTEMPTS`, `DEFAULT_LLM_STEP_TIMEOUT_MS`, `DEFAULT_MCP_DEFER_TOOLS_OVER`) so `config/` never imports upward (config-loader.ts:17-21).
4. **Module splits** (each with its paired test moving along):
   - `run-loop-adapter.ts` → tool-resolution / subagent-session (the ~60-line ×4 setup litany → `buildSubagentSession`) / planner-wiring; delete the adapter-local duplicate `github` tool (keep `tools/github-thread-tool.ts`).
   - `worker.ts` (1484) → editor-fanout + git commit phase + verify gate.
   - `work-loop.ts` (1320) → prPerTask mode out.
   - `orchestrator.ts` → `pr-body.ts` (~450 lines of text machinery).
   - `step-progress.ts` (435) → format/sink/renderer.
   - `config-loader.ts` (640) → `claude-code-config.ts` reader.
   - `coding-style.ts` — inject `OnUsage` instead of importing from subagents (layering inversion).
5. **Dedup util extractions**: `describeError` (work-loop/run-loop-adapter), fs-safe `sanitize` (3 variants in state/), cycle-safe serializer (logger/compactor — done in slice 08 if already landed), `detectRuntime` (oauth/llm-fetch).
6. **Packaging hygiene**: exclude `src/testing` from `tsconfig.build.json`; drop web-search internals (`decodeDdgHref`, `parseDuckDuckGoHtml`, `DEFAULT_STEALTH_HEADERS`, `DEFAULT_IMPERSONATE_TARGETS`) from `index.ts` barrel; resolve templates decision (slice 04).
7. **Portability policy**: decide `import process from 'node:process'` sweep (16 files) vs documenting Deno-via-npm-compat only; apply consistently.
8. **CLAUDE.md refresh**: module map (10 of 19 dirs undocumented), provider-wiring invariant ("credentials + openrouter, presets in config"), testing claim (see slice 11), inbound-HTTP carve-out (per slice 04 decision), atomic-write duplication note vs `ai-claude-compat`.

## Tests
- No new behavior — the bar is: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint` green after every numbered step (each step is a separate commit/PR-able unit); import-cycle check (e.g. `madge --circular`) clean at dir level.

## Done when
- Zero dir-level import cycles; one composition root; no shipped file >800 LOC with multiple reasons to change; CLAUDE.md matches the code.

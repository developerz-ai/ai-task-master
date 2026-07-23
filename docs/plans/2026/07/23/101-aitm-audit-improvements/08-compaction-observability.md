# 08 — Compaction guarantee & observability wiring

> Part of [`overview.md`](overview.md). Depends on: none.
> Findings: [`findings/06-observability-logger-compaction-plan-tools.md`](findings/06-observability-logger-compaction-plan-tools.md) (bugs 2-4, 7-12; arch 1-5; tests 1-2), [`findings/05-mcp-openrouter-credentials-agent-config.md`](findings/05-mcp-openrouter-credentials-agent-config.md) (openrouter + agent-config items).

## Files to change
- `packages/aitm/src/compaction/compaction-step.ts` — `:144-152` prune path can still overflow the window (HIGH); `:91,204-213` raw `JSON.stringify` crash on circular/BigInt (reuse `compactor.ts` `safeStringify`); `:131-134` original task brief lost to summarization; `:85-90` re-summarize every step (cache keyed on message-array length).
- `packages/aitm/src/logger/logger.ts:40` — `new Logger(...)` has zero production callers: the whole structured-logging module is dead code and every `logger?.warn` a no-op. Construct in `cli/commands.ts`, thread through the run; pass at all four `buildCompactionStep` sites (`run-loop-adapter.ts:1275-1279,1378-1382`, `ci-fix.ts:275`, `self-review.ts:211`).
- `packages/aitm/src/tools/datetime.ts:41-50` — returns UTC labeled with the requested timezone; return `formatter.format(date)` alongside ISO. Fix the test that bakes it in (`datetime.test.ts:23`).
- `packages/aitm/src/plan/schema.ts:72-76` — `.min(1)` on groups (inside the schema-retry loop); `plan-markdown.ts:46-53` — surface orphan task lines / unknown complexity tags.
- `packages/aitm/src/observability/run-step.ts:72-78` — unknown task id → `undefined`, clamp fallback.
- `packages/aitm/src/tools/github-thread-tool.ts:46-48` — error string on missing body.
- `packages/aitm/src/tools/web-fetch.ts:235-239` — truncated flag on exact-cap stream.
- `packages/aitm/src/openrouter/model-limits.ts:152-158` — `maxOutputTokens` in `hasGap`; shared `fetchCatalog` helper for `client.ts:109-111`/`reference-catalog.ts:35-39` (with `AbortSignal.timeout` from slice 03).
- `packages/aitm/src/credentials/credentials.ts:60` — explicit OpenRouter baseURL should still count as on-OpenRouter.
- `packages/aitm/src/agent-config/` — absolute out-of-repo stylePath expansion root (`agent-config-detector.ts:81-94`); trailing-punctuation `@import` capture (`expand-imports.ts:144`); warn on non-ENOENT readdir (`:118`).
- `packages/aitm/src/state/transcript-store.ts:100` — `console.debug` → Logger/onWarn (stdout contract).

## Steps
1. Compaction: after prune, re-estimate; fall through to summarize when still over budget; escalate summarize → hard-truncate-oldest until it provably fits (post-compaction verification). Keep run's first user message verbatim ahead of any summary. Guard `estimateTokens` with `safeStringify`. Cache compacted result.
2. Wire Logger into production + the four compaction sites; extract the shared cycle-safe serializer (`logger.ts:146-165` vs `compactor.ts:203-213`, both cite #251).
3. Land the tool/plan/openrouter/credentials/agent-config point fixes above.

## Tests
- Compaction: prune-still-over-budget, circular/BigInt message, brief-preservation, cache-hit.
- Logger-wired smoke: compaction warning actually reaches stderr.
- datetime timezone output; plan `.min(1)` retry; catalog timeout.

## Done when
- Context can never be sent overflowing; the structured logger is live in shipped runs; every point fix has a regression test.

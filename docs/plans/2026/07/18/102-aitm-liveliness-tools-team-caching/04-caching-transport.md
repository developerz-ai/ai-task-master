# 04 — Prompt caching, transport, cost

> Part of [`overview.md`](overview.md). Depends on: none.
> Steals: opencode `applyCaching` breakpoints + `prompt_cache_key`=sessionID (`provider/transform.ts:1142-1150,1245`), Kimi `prompt_cache_key`=session-id (`llm.py:360-362`), OpenRouter `session_id` sticky routing, undici keep-alive tuning.

## Files to change
- `packages/aitm/src/credentials/credentials.ts:26-60` — `chatSettings`: caching + session params per provider family.
- `packages/aitm/src/credentials/defaults.ts` — nothing model-wise; document cache behavior.
- `packages/aitm/src/config/provider-presets.ts:11-29` — add `moonshot` preset (api.moonshot.ai OpenAI-compatible, kimi-k2 family); annotate presets with `caching: 'automatic' | 'cache_control'`.
- New: `packages/aitm/src/credentials/llm-fetch.ts` + test — keep-alive fetch factory.
- `packages/aitm/src/observability/usage-tracker.ts:46-113` — cache read/write + discount columns; cost via pricing catalog.
- `packages/aitm/src/openrouter/client.ts:37-47` — reuse `listModels` pricing for cost resolution (cached per run).
- `packages/aitm/src/cli/commands.ts:201-208` — usage line gains `cache-hit %` and real `$`.
- `packages/aitm/src/loop/run-loop-adapter.ts:374-379` — cache-hostile prompt fix (dynamic block placement).

## Steps
1. **Session stickiness + implicit cache key**: generate one run-scoped id (persist in state so resume reuses it per group/stage conversation). In `chatSettings`, pass provider options: OpenRouter → `session_id` (sticky upstream routing) and `prompt_cache_key` for OpenAI-family routes; direct OpenAI-compatible baseURLs (z.ai, moonshot) → `prompt_cache_key` only. Verify the `@openrouter/ai-sdk-provider` passthrough mechanism (extraBody/providerOptions) — if it can't carry arbitrary body keys, inject via the custom fetch (step 3) body rewrite.
2. **cache_control scope**: keep `anthropic/*` ephemeral breakpoints (`credentials.ts:53-58`) but stop dropping it when `baseURL` is custom-yet-OpenRouter-shaped; add Qwen/Alibaba to the `cache_control` family per OpenRouter docs. Everything else relies on automatic upstream caching — no-op.
3. **Keep-alive fetch** (`llm-fetch.ts`): factory returning a `fetch` for the provider: on Node, dynamic-import `undici`, build `Agent({keepAliveTimeout: 60_000, connections: 16})`, pass as `dispatcher` per request; on Bun/Deno (or undici unavailable) return global fetch (native pooling). Feature-detect via `process.versions.bun` / `typeof Deno` — no `Bun.*` APIs. Wire into `providerSettings` (`credentials.ts:81-86`) as `fetch`.
4. **Stable prompt prefix**: `harnessContextBlock` (`run-loop-adapter.ts:374-379`) injects `currentDate` + `Step N of M` into the FIRST user message — a per-step mutation near the prefix. Move the dynamic `runProgress` into the LAST message of each request (or a trailing system-reminder), keep `currentDate` date-only (stable within a day). Audit other per-call dynamic strings early in prompts (memory index ordering, style digest) — they must be byte-identical across calls in a conversation.
5. **Usage/cache reporting**: extend `UsageTracker.record` to capture `cachedInputTokens` AND provider-metadata cache-write/discount when present (OpenRouter `cache_discount`, requires usage accounting enabled — send `usage: {include: true}` if the provider supports it). Summary line: `Usage: N calls, X in (Y% cached) / Z out, $C — per-role…`.
6. **Real cost**: `ModelLimitsLookup` returns `null` for unknown models → on flush, resolve missing prices once via `OpenRouterClient.listModels` (only when baseURL is OpenRouter; else keep `cost unknown`). Cache the catalog in-memory per run; network failure → silent fallback to null.
7. **Moonshot preset**: `provider-presets.ts` gains `moonshot` (baseURL `https://api.moonshot.ai/v1`, models kimi-k2.5 family, automatic caching, `prompt_cache_key` on). Paired test updates.

## Tests
- `credentials.test.ts`: chatSettings emits session/cache params per family; anthropic breakpoints preserved; z.ai/moonshot get `prompt_cache_key` only.
- `llm-fetch.test.ts`: Node path returns dispatcher-wrapped fetch (mock undici import); Bun path returns global fetch (gate with `process.versions.bun`).
- `usage-tracker.test.ts`: cache columns, catalog-priced cost, unknown stays null.
- `provider-presets.test.ts`: moonshot preset shape.
- A/B smoke (manual, record in PR body): one small real run before/after step 4, compare `cached_tokens` ratio.
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- Requests carry session stickiness + cache keys per provider family; keep-alive dispatcher active on Node; usage line shows cache-hit % and real cost on OpenRouter defaults; measured cache-hit ratio improves on the A/B smoke run.

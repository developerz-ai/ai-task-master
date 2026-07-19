# aitm: liveliness, tool efficiency, team fanout, caching & transport

## Goal
Close the gap between aitm and the best agentic CLIs (Claude Code, Kimi CLI, opencode, claudetm) for big `aitm start '...'` runs: readable live output, oversized-output spill instead of destructive truncation, robust PR composition (no more `blocked: title >72 chars` after 10M tokens), provider-level prompt caching + keep-alive transport, bounded "football team" editor fanout, and cheaper context management.

## Context
- Stack: Bun dev runtime, must run unchanged on Node ≥20 / Deno ≥1.40; ESM only; `ai` package `ToolLoopAgent`-style agents; OpenAI-compatible inference via `Credentials` (`@openrouter/ai-sdk-provider`, `createOpenRouter` at `packages/aitm/src/credentials/credentials.ts:139-145`); `gh` CLI wrapper; no streaming today — everything is `generateText`.
- Live console contract: `packages/aitm/src/observability/step-progress.ts` (prefix `:80-87`, `renderStepLines:154-171`, `summarizeToolInput:111-151`, `DETAIL_MAX=250`). Structured `Logger` (`packages/aitm/src/logger/logger.ts:40`) is a separate stderr/file sink.
- Retry loop: compat `packages/ai-claude-compat/src/subagent.ts` `callWithRetry:205-223` — silent, no Retry-After parsing.
- PR composition: `packages/aitm/src/orchestrator/orchestrator.ts` `composePr:322-398`, schema `:191-195`, `assertPrBodySections:168-187` — single-shot, throw → group `blocked` (`work-loop.ts:428-458`).
- Editor fanout: `packages/aitm/src/subagents/worker.ts` `runEditorFanout:481-505` — one editor per manifest file, unbounded `Promise.all`, no shared context.
- Caching today: `cache_control: ephemeral` only when model id starts `anthropic/` and no custom baseURL (`credentials.ts:53-58`). No `prompt_cache_key`, no `session_id` stickiness, no custom fetch/keep-alive.
- Research findings the slices lean on (verified 2026-07-18):
  - OpenRouter: per-upstream caching (Anthropic `cache_control` breakpoints; OpenAI/DeepSeek/Gemini/Moonshot automatic), `session_id` body param for sticky upstream routing, usage `prompt_tokens_details.cached_tokens` + `cache_discount`. Moonshot + z.ai direct: automatic caching, OpenAI-compatible `cached_tokens` reporting.
  - undici (Node global fetch): keep-alive default idle timeout **4s** — sequential LLM calls re-handshake; tune via `Agent({keepAliveTimeout})` + custom `fetch` on the provider.
  - Oversized-output consensus (Claude Code, opencode `tool/truncate.ts`, gemini-cli): cap in context + spill full output to a file + tell the model to Read(offset)/grep the file. Kimi CLI: central `ToolResultBuilder` (50k chars), background jobs return tail + `output_path`.
  - claudetm readability recipe: blank line before every tool call, one distilled arg per tool, cwd-relative paths, module-global task context in every prefix, color-coded speaker, tool bodies suppressed.
  - opencode: prune-before-compact (clear old tool outputs, 40k recency shield), anchored updatable summaries, retry layer with Retry-After, doom-loop guard, tool-call repair.
- Reference pattern for schema-retry: compat `runWithSchemaRetry` (used by planner/worker; NOT by composePr).

## Plan files (execute in order; 01–06 are independent, 07 depends on 01)
1. [`01-observability-liveliness.md`](01-observability-liveliness.md) — readable live output: blank lines, short labels, retry/heartbeat lines, reasoning, style-distill progress, warning spam fix.
2. [`02-tool-output-spill.md`](02-tool-output-spill.md) — spill oversized tool output to file + paging; wire background bash; doom-loop guard + tool-call repair.
3. [`03-pr-composition-robustness.md`](03-pr-composition-robustness.md) — composePr schema retry + deterministic fallback; composition failure never blocks a group.
4. [`04-caching-transport.md`](04-caching-transport.md) — prompt caching per provider, stable prompt prefix, keep-alive fetch, cache/cost stats, moonshot preset.
5. [`05-editor-team-fanout.md`](05-editor-team-fanout.md) — bounded editor pool, file grouping, shared context digest, per-teammate log identity.
6. [`06-context-pruning-compaction.md`](06-context-pruning-compaction.md) — prune-before-compact, anchored summaries, usage-grounded token counts.
7. [`07-streaming-liveliness.md`](07-streaming-liveliness.md) — adopt `streamText` for live text + stall watchdog (higher risk, gated).

## Done when
- A full `aitm start` run reads like the claudetm sample: task/group boundaries with blank lines, short prefixes, one distilled arg per tool line, visible retries ("Rate limited, retrying in Ns (n/10)"), no silent multi-minute gaps, no `warning: skipping a transcript message` spam.
- No tool result over its cap is destructively lost: full output lands under `.ai-task-master/tool-output/` and the model demonstrably pages it back (integration test).
- PR composition failure can no longer mark a group `blocked`: schema retry + deterministic fallback covered by unit tests; the `title>72` scenario from run 101 passes.
- Usage summary prints cache hit tokens, cache discount when available, and a real `$` cost for known models (no more `cost unknown` on OpenRouter defaults).
- Editor fanout bounded (config `concurrency`, default ≤4) with per-editor labels in the console; behavior identical for single-file manifests.
- All gates green on Bun and Node: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`; every touched module keeps its paired `*.test.ts`.

## Risks / open questions
- Streaming adoption (07) touches every generate site via compat — land last, behind config `streaming` (default off) until burn-in.
- Prompt-prefix reordering (04) changes what the model sees first; A/B a smoke run before defaulting.
- undici is a new runtime dep for keep-alive tuning on Node; Bun/Deno fall back to native pooling (portability rule: no `Bun.*`; dynamic import + feature-detect).
- `tmp/kimi` + `tmp/opencode` research clones are untracked and NOT gitignored — executor should add `tmp/` to `.gitignore` (or delete the clones) before any `git add -A`.
- Out of scope (hard): mailbox, aitm-as-MCP-server, webhooks/inbound HTTP, Docker. Kimi's D-Mail/checkpoint-revert and opencode SQLite storage are explicitly not planned.

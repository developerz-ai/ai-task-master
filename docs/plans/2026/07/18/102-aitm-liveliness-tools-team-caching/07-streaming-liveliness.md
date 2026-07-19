# 07 — Streaming adoption (gated)

> Part of [`overview.md`](overview.md). Depends on: 01. Higher risk — config-gated `streaming: false` default until burn-in.
> Steals: Kimi two-regime stream-idle watchdog (claudetm `agent_query.py:46-66,488-554` variant), Kimi live tool-arg preview (streamed-JSON lexing — optional stretch), opencode per-chunk SSE timeout (`provider.ts:1762`) and stream-based rendering.

## Files to change
- `packages/ai-claude-compat/src/subagent.ts` — the single generate funnel (`callWithStepTimeout` → `callWithRetry`) gains a `streamText` path; step results normalized so callers see the same shape.
- `packages/aitm/src/observability/step-progress.ts` — render text deltas line-buffered (print on newline, not per-token) using the 01 sink.
- `packages/aitm/src/config/schema.ts` — `streaming` flag.
- `packages/aitm/src/loop/run-loop-adapter.ts` — thread flag to all subagent factories.

## Steps
1. **Streaming funnel**: add `streamText` alternative inside the compat funnel; consume the stream, forward text-deltas + tool-call events to an optional `onStream` sink, and resolve to the same final result object `generateText` returns (`await result.text/steps`). Retry/timeout wrappers unchanged around the whole stream.
2. **Stall watchdog**: replace the flat `stepMs` deadline in streaming mode with per-chunk inactivity timeout (120s no chunk → abort + retry once) plus overall cap; after finish-reason arrives, a short 30s grace regime (two-regime pattern — never re-run a completed coding step; duplicate-PR hazard).
3. **Line-buffered rendering**: progress sink prints assistant text as it streams, buffered to whole lines, respecting 01 blank-line rules; tool lines still render on tool-call events (before results — earlier than today's post-step rendering).
4. **Gating + parity tests**: `streaming:false` must remain byte-identical in behavior; e2e-smoke integration runs once with the flag on.

## Tests
- `subagent.test.ts` (compat, MockLanguageModel streaming): funnel parity of final results; watchdog aborts a stalled mock stream; grace regime does not retry after finish.
- `step-progress.test.ts`: line-buffered delta rendering.
- Integration: `e2e-smoke` variant with `streaming: true`.
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- With `streaming: true`, text and tool lines appear live during generation, stalled streams recover, and all existing tests pass with the flag off (default).

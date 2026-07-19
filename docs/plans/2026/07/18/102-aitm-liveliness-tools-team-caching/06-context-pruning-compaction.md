# 06 — Context pruning & compaction

> Part of [`overview.md`](overview.md). Depends on: none.
> Steals: opencode prune-before-compact (`session/compaction.ts:243-287`) + anchored updatable summaries (`core/src/session/compaction.ts:161-168`), Kimi usage-grounded token accounting (`context.py:76-77`).

## Files to change
- `packages/aitm/src/compaction/compaction-step.ts:41-127` — pruning stage before summarization; anchored summary.
- `packages/aitm/src/compaction/compactor.ts:57-95` — accept prior summary for update-in-place; usage-fed token counts.
- `packages/aitm/src/observability/usage-tracker.ts` — expose last-call input tokens per conversation (feed the trigger).
- `packages/aitm/src/loop/run-loop-adapter.ts:842-846` — wire usage feed into the shared Compactor.

## Steps
1. **Prune first**: in `buildCompactionStep`, before invoking the LLM summarizer, walk messages older than the last `keepLastSteps=6`, replace completed tool-result contents (over ~1k chars) with `[old tool result cleared — rerun the tool if needed]`, keeping a 40k-char recency shield of tool output. Only if pruning frees <20k chars proceed to LLM compaction. Cheap pass, no model call.
2. **Anchored summary**: when a `SUMMARY_HEADER` block already exists in the prefix, pass it to `Compactor.compact` as `<previous-summary>` and prompt for an UPDATED summary (opencode template sections: objective / done / in-progress / files / next) instead of re-summarizing from scratch.
3. **Usage-grounded trigger**: `shouldCompact` (`compactor.ts:57-77`) currently estimates chars/4 over live messages; prefer the API-reported input tokens of the conversation's last call (from `UsageTracker` via a per-conversation sink) and only char-estimate the delta appended since. Fewer premature/missed compactions.
4. **Cache interaction note** (doc comment + PR body): pruning/compaction rewrites the prefix → one-time cache miss; that's why prune thresholds are conservative and compaction stays rare (aligns with 04's stable-prefix work).

## Tests
- `compaction-step.test.ts`: prune clears old tool results, respects recency shield, skips LLM when enough freed; anchored update path passes previous summary.
- `compactor.test.ts`: usage-fed trigger math; fallback to estimate when no usage yet.
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- Long worker conversations prune before summarizing (observable in transcript records), summaries update instead of restarting, and compaction triggers track real usage tokens.

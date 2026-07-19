# 01 — Observability & liveliness

> Part of [`overview.md`](overview.md). Depends on: none.
> Steals: claudetm console recipe (blank-line-before-tool, one distilled arg, cwd-relative paths, global task context), Kimi status-line ideas, opencode `ctx.metadata` display-ready titles.

## Files to change
- `packages/aitm/src/observability/step-progress.ts` — rendering upgrades (blank lines, short labels, relative paths, reasoning line).
- `packages/ai-claude-compat/src/subagent.ts:193-257` — `callWithRetry`/`defaultRetryDelayMs`: add `onRetry` callback param, thread through `callWithStepTimeout`.
- `packages/aitm/src/loop/run-loop-adapter.ts` — wire `onRetry` → progress line; style-distill progress; heartbeat.
- `packages/aitm/src/state/transcript-store.ts:87-98,202-205` — aggregate the invalid-message warning.
- `packages/aitm/src/cli/commands.ts:201-208` — usage line: add per-group timing; keep cost/cache columns (04 fills values).
- `packages/aitm/src/agent-config/coding-style.ts` (distiller) — progress callback naming files read.
- New: `packages/aitm/src/observability/heartbeat.ts` + paired test.

## Steps
1. **Blank-line chunking** (claudetm `agent_message.py:63-66` pattern): in `renderStepLines` (`step-progress.ts:154-171`) emit one blank line before the first tool line of a step and before each agent-text line. Guard: never two consecutive blanks.
2. **Short labels**: `agentLabel` (`step-progress.ts:54-62`) currently embeds the full group slug every line → cap label to `role + g<N>` (e.g. `k3 worker g1`); print the full slug once on group start via `harnessProgress`. Add `editor:<basename>` labels (05 consumes this).
3. **Relative paths + arg distillation**: in `summarizeToolInput` (`:111-151`) make `file_path`/`path` cwd-relative (claudetm `_relative_path` idea); keep `DETAIL_MAX=250` for `command`, drop to 120 for paths/patterns.
4. **Retry visibility**: add `onRetry(info: {attempt, maxAttempts, delayMs, reason})` to `callWithRetry` options (`subagent.ts:205-223`). Parse `Retry-After` header/body when present (opencode `session/retry.ts` pattern) and honor it for the delay. Adapter renders: `Rate limited (429), retrying in 15s (3/10)` — never an empty `Rate limited:` line.
5. **Heartbeat** (`observability/heartbeat.ts`): `startHeartbeat(label, sink)` → timer printing `still working… 2m10s` every 60s while no other progress line was emitted (track last-emit timestamp in the sink). Start/stop around every subagent `generate` call in `run-loop-adapter.ts`. Non-TTY safe (plain line, no ANSI rewrite).
6. **Reasoning line**: extend `StepProgressEvent` (`step-progress.ts:21-24`) with optional `reasoningText`; `composeStepFinish` source already receives SDK step — pass `step.reasoningText` when present. Render dim, clipped to 200 chars, prefixed `thinking:`. Config `showReasoning` (default true).
7. **Style-distill progress**: the `coding style: distilling…` phase runs a fast-tier agent with read tools — attach `agentStepProgress('style', …)` so each `readFile` shows (`coding style: reading CLAUDE.md`, …). User-visible answer to "what files is he reading".
8. **Transcript warning aggregation**: `validMessages` (`transcript-store.ts:87-98`) fires `onWarn` per bad element → count and emit ONE summary warning per reconstruct (`skipped N invalid transcript messages`). Root-cause note: record which schema field failed at debug level.
9. **Task/group timing**: `WorkLoop` already brackets tasks — print `task done in 7.2m` on `completeTask` (`work-loop.ts:888-913`) and group totals at `merged`, claudetm-style (active-work vs CI-wait split optional, needs `pr_active_work` accumulator in state schema — include only if trivial).

## Tests
- `step-progress.test.ts`: blank-line rules, relative paths, reasoning line, label shortening (snapshot the rendered lines with a fake sink/clock).
- `subagent.test.ts` (compat): `onRetry` invoked with parsed Retry-After; delay honored.
- `heartbeat.test.ts`: fires only during silence; stops on progress.
- `transcript-store.test.ts`: N invalid messages → 1 warning.
- Gates: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- A recorded fake-sink run renders: group header, blank-line-separated tool steps, distilled args with relative paths, a retry line with countdown, a heartbeat during a stubbed 3-minute silent call, one aggregated transcript warning.

# 03 — Cancellation & resource lifecycle

> Part of [`overview.md`](overview.md). Depends on: none. Cross-package: needs `signal` support in `packages/ai-claude-compat`.
> Findings: [`findings/07-resource-lifecycle-sweep.md`](findings/07-resource-lifecycle-sweep.md) (all), [`findings/01-loop.md`](findings/01-loop.md) (bug 6; resources 1-5), [`findings/02-subagents-orchestrator.md`](findings/02-subagents-orchestrator.md) (resources 1-4), [`findings/06-observability-logger-compaction-plan-tools.md`](findings/06-observability-logger-compaction-plan-tools.md) (resources 1-4), [`findings/03-cli-config.md`](findings/03-cli-config.md) (resources 1-4).

Copy the good pattern already in-tree: `subagents/worker.ts:984-1038` (AbortController + listener removal in finally).

## Files to change
- New `packages/aitm/src/fs/sleep.ts` (or `loop/sleep.ts`) — abortable `sleep(ms, signal)`.
- New `packages/aitm/src/loop/disposer.ts` — run-scoped `Disposer` (`add(fn)`, idempotent `disposeAll()`). Hand-rolled, NOT `AsyncDisposableStack` (Node 20 / Deno 1.40 portability).
- `packages/ai-claude-compat/src/subagent.ts:935` — add `signal` param to `runSubagent`/`agent.generate`.
- `packages/aitm/src/subagents/factory.ts` — `signal` on `SubagentInit`; forward at all 4 create sites (planner/reviewer/worker/scouts).
- `packages/aitm/src/loop/{work-loop.ts,stage-handlers.ts,take-over-flow.ts,ci-fix.ts,self-review.ts}` — thread `signal` into `StageDeps`, poll loops, grace sleeps.
- `packages/aitm/src/github/github-client.ts:41-59,75-80` — `defaultRunCmd` gains `timeout`+`cancelSignal`; `defaultSleep` → abortable.
- `packages/aitm/src/workspace/git-exec.ts:66`, `orchestrator/orchestrator.ts:71` — same execa timeout/signal chokepoints.
- `packages/aitm/src/loop/run-loop-adapter.ts:639-642,764,631-632,1189…` — unconditional `mcp.close()` in finally; `.catch` on `reapOnAbort` close; prune `workerHandles`/`ciFixHandles` on terminal group stages; `plannerRecorder.end()` in finally.
- `packages/aitm/src/credentials/llm-fetch.ts:77-85` — return `{ fetch, close }`; don't clobber caller's `dispatcher`; dispose at run end via Disposer.
- `packages/aitm/src/mcp/oauth.ts:96-102` — `proc.on('error', …)` on the browser spawn (currently crashes the process on headless hosts).
- `packages/aitm/src/cli/cli.ts:197-238` — unified shutdown: flush Logger + UsageTracker + reporter on normal exit AND first signal; `process.exitCode` instead of hard `exit` where possible; force-exit path still flushes (bounded).
- `packages/aitm/src/observability/{usage-tracker.ts,heartbeat.ts:55-58,error-reporter.ts:61-89}` — persist/flush spend on signal; `unref()` heartbeat; reporter `close()`.

## Steps
1. Land compat `signal` support first (blocking dependency).
2. Add `sleep(ms, signal)` + `Disposer`; unit-test both (abort mid-sleep clears timer; disposeAll runs all, tolerates throwers, idempotent).
3. Thread `RunLoopInput.signal` per file list above; check `signal.aborted` at top of every poll iteration.
4. Execa chokepoints: `timeout` + `cancelSignal` in `defaultRunCmd`/`runGit`; `AbortSignal.timeout` on `OpenRouterClient.listModels` + `reference-catalog.ts:34`.
5. Register on the run Disposer: MCP manager close, llm-fetch agent close, transcript flush, usage flush; call from adapter `finally` and `reapOnAbort`.
6. CLI shutdown unification per findings/06 resources 1-2 and findings/03 resources 1-2.

## Tests
- Worker/planner/reviewer signal wiring (fake model that blocks until abort); `waitForChecks` abort mid-sleep returns promptly; partial `connectAll` failure still closes connected clients; `openBrowser` spawn-error path (stub spawner); Disposer unit tests.

## Done when
- One Ctrl-C cancels LLM streams, sleeps, and child processes within seconds (integration-testable with stub sleeps); every acquisition has a registered release; no fire-and-forget close without `.catch`.

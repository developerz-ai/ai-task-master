# Findings — cross-cutting resource-lifecycle ("RAII") sweep

> Raw report from parallel audit agent. Scope: every acquisition/release pattern in `packages/aitm/src/`.

## Process / child-process lifecycle

- [severity: high] [category: resource] `mcp/oauth.ts:96-102` — `openBrowser()` calls `spawn(command, args, { detached: true, stdio: 'ignore' })` with **no `'error'` listener** on the returned ChildProcess. On any host where the opener binary is missing (`xdg-open` on headless Linux — the common case for a CLI agent tool), spawn's failure is emitted asynchronously as an `'error'` event with no listener, which throws uncaughtException and **crashes the whole `aitm mcp-login` process** (skipping the `finally { await server.stop() }`). Fix: `proc.on('error', () => { /* print the auth URL, ask the user to open it manually */ })`. `mcp/oauth.test.ts` has no coverage of the spawn path at all.
- [severity: med] [category: resource] `mcp/mcp-client.ts:73` — `const config = buildClientConfig(name, server)` sits **outside** the per-server `try` in `connectAll()`. If the `Experimental_StdioMCPTransport` constructor throws for server N (bad cwd/env shape), `connectAll()` rejects; in `run-loop-adapter.ts:637-642` `mcpConnected` is then never set true, so the `finally` at `run-loop-adapter.ts:764` **skips `mcp.close()`** — servers 1..N-1's already-connected clients leak: stdio children survive until the process-exit SIGKILL guard, http/sse connections leak for the process lifetime. Fix: move `buildClientConfig` inside the `try`, and/or make the adapter's `finally` call `mcp.close()` unconditionally (idempotent by design).
- [severity: low] [category: resource] `loop/run-loop-adapter.ts:632` — `reapOnAbort` does `void mcp.close()` fire-and-forget; if an http/sse `client.close()` hangs, nothing escalates until process exit; worth a timeout race around the close.
- [severity: low] [category: resource] `github/github-client.ts:41-59`, `workspace/git-exec.ts:66`, `orchestrator/orchestrator.ts:71` — every `execa('gh'|'git', …)` call runs with **no `timeout` and no abort signal**. A network-wedged `gh api`/`gh pr checks` blocks the run indefinitely, and a SIGINT abort cannot kill an in-flight subprocess (only the second-SIGINT force-exit does, orphaning it). Fix: pass `{ timeout }` (and `cancelSignal` in execa ≥8) at the `defaultRunCmd`/`runGit` chokepoints.

## Abort/signal propagation (acquired LLM streams kept running)

- [severity: med] [category: resource] `subagents/worker.ts:1110` is the **only** place `abortSignal` reaches a `generateText` call. Planner (`run-loop-adapter.ts:995-1011`), Reviewer (`:1332-1348`), Worker manifest pass, CI-fix session (`loop/ci-fix.ts`), self-review (`loop/self-review.ts`), Compactor (`compaction/compactor.ts:183`), scouts (`subagents/planner-scouts.ts:184`) and the explore child (`subagents/explore.ts`) never receive `RunLoopInput.signal`. After first Ctrl-C, all these in-flight LLM streams keep running (and billing) to completion; `WorkLoop` only checks `signal.aborted` between iterations (`loop/work-loop.ts:395,407,445`). The worker editor fanout (`worker.ts:984-1038`) shows the correct pattern (shared `AbortController`, `removeEventListener` in `finally`) — thread the same signal through `SubagentInit` into every `createSubagent`/`generateText` site.
- [severity: med] [category: resource] `github/github-client.ts:75-80,236-278` — `defaultSleep` is a bare `setTimeout` promise and `waitForChecks` polls up to 120 min with sleeps up to 60s; neither is abort-aware. Same for take-over cooldown sleeps (`loop/take-over-flow.ts`) and `REVIEW_COMMENTS_GRACE` (2 min) in `loop/stage-handlers.ts:155`. Fix: an abortable `sleep(ms, signal)` (listener + `clearTimeout` in `finally`) threaded from the run signal; check `signal.aborted` at the top of each poll iteration.

## Sockets / HTTP

- [severity: low] [category: resource] `credentials/llm-fetch.ts:77-80` — the undici `Agent` (60s keep-alive, 16 connections) is created and **never `destroy()`/`close()`d**, no handle returned to any owner. Masked in the CLI because `cli/cli.ts:203` always `process.exit()`s, but any embedding of the exported `main()` keeps idle sockets holding the event loop up to 60s, one leaked Agent per `createLlmFetch()` call. Fix: return `{ fetch, close }` and dispose at run end.
- [severity: low] [category: resource] `mcp/oauth.ts:199-206` — `NodeServer.stop()` awaits `server.close()`, which does not terminate an active keep-alive connection (the browser that just received the success page holds one). Fix: `server.closeAllConnections()` (Node ≥18.2) before/after `close()`.
- [severity: low] [category: resource] `openrouter/client.ts:106` — `listModels()` fetch has no `AbortSignal.timeout`; a stalled `/models` endpoint hangs run startup indefinitely. The sibling tools (`tools/web-fetch.ts:316`, `tools/web-search.ts:175`) all use `AbortSignal.timeout` — mirror that here.

## Timers, exits, files

- [severity: low] [category: resource] `cli/cli.ts:203,208` — `process.exit(code)` immediately after the final stdout/stderr writes can truncate pending piped output on platforms where pipe writes are async (Windows). Resolve write callbacks or use `process.exitCode` + natural exit (fix together with the undici-agent disposal above).
- [severity: low] [category: resource] `loop/progress-file.ts` + `run-loop-adapter.ts:322` (`void recorder.step(...)`) — progress.md/transcript appends are fire-and-forget chains with no awaited flush before `process.exit`; the last lines of a run can be silently lost. A final `await chain` in the run's `finally` would cost nothing.
- [severity: low] [category: resource] `testing/temp-repo.ts:16` — `mkdtemp` cleanup is returned to the caller, but a test that throws before calling `cleanup()` leaks the tempdir; a `Symbol.asyncDispose` on `TempRepo` would enable `await using`.

## Verified clean (worth stating)

- `mcp/stdio-process-registry.ts` — exemplary: liveness-probed SIGTERM→SIGKILL escalation, synchronous `exit` guard armed/disarmed symmetrically, EPERM handled. Well tested.
- `fs/atomic-write.ts` — handle closed in nested `finally`, temp file removed on both failure paths, parent-dir fsync handle closed in `finally`.
- `tools/web-fetch.ts` / `web-search.ts` — redirect bodies cancelled per hop, capped body reader cancels + releases lock in `finally`, non-200 bodies cancelled.
- `subagents/worker.ts:984-1038` — fanout AbortController wiring with listener removal in `finally` is the model the rest of the codebase should copy.
- `observability/heartbeat.ts` — every call site (5 in `run-loop-adapter.ts`) stops it in a `finally`; stop is idempotent.
- `state/transcript-store.ts:243-244` — `open(…, 'wx')` handle closed on both success and EEXIST-retry paths.
- `loop/work-loop.ts:455-493` — checkout slot released in inner `finally` plus defensive outer catch-release.
- `cli/commands.ts:874-883` — readline closed in `finally`.

## Systemic recommendations

- **No central disposal pattern exists.** Lifecycle is hand-rolled per site: try/finally in the adapter, two independent reapers (`StdioProcessRegistry`, compat `ProcessManager`), an ad-hoc abort listener, and an undici agent with no owner. A small run-scoped `Disposer` (`add(fn)` + `disposeAll()` called from the adapter's `finally` *and* from `reapOnAbort`) would give every acquisition one guaranteed exit path. Avoid `await using`/`AsyncDisposableStack` for now: Node 20 / Deno 1.40 portability is a house rule and `DisposableStack` isn't reliably available there; a hand-rolled Disposer is.
- **One abortable-sleep + one signal-threading convention.** Add `sleep(ms, signal)` next to `defaultSleep` and add `signal` to `SubagentInit`, then sweep the ~8 LLM call sites and 3 poll loops. This closes the entire "first Ctrl-C does nothing for minutes" family in two primitives.
- **Chokepoint timeouts for subprocesses and startup fetches.** `defaultRunCmd`, `runGit`, and `OpenRouterClient.listModels` are single funnels — a `timeout`/`AbortSignal.timeout` at each covers every caller.
- **Test the failure-path cleanup, not just the happy path.** Untested today: `openBrowser` spawn failure (crashes), `connectAll` partial-connect leak on a throwing transport constructor, oauth `server.stop()` under a held keep-alive connection, undici agent teardown.

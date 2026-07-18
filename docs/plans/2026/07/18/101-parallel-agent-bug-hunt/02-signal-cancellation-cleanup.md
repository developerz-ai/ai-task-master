# 02 — Signal handling + cancellation cleanup (RAII)

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `packages/aitm/src/cli/cli.ts:12-22,132-146` — `MainCtx` gains `signal`; entrypoint registers handlers.
- `packages/aitm/src/cli/cli.ts:63-71` — `buildMergePrCtx` threads `ctx.signal` (consumer at `commands.ts:537` already exists).
- `packages/aitm/src/loop/run-loop-adapter.ts:596-600` — MCP close must not rely on an async `finally` surviving default signal termination.
- `packages/aitm/src/subagents/worker.ts:288,445` — editor fanout shared abort.
- `packages/aitm/src/testing/temp-repo.ts:15-31` — cleanup on setup throw.

## Steps
1. **Wire the dead cancellation path** (cleanup #1, high). Entrypoint: create one `AbortController`; `process.on('SIGINT')`/`('SIGTERM')` → `controller.abort()`. Thread `controller.signal` through `MainCtx` → `buildMergePrCtx` → start/merge flows. Today `signal` is always `undefined` from the real binary; `take-over-flow.ts:174,279` `{ kind: 'cancelled' }` is unreachable.
2. **Cleanup on abort**: on abort, explicitly `await mcp.close()` (child processes from `Experimental_StdioMCPTransport`, `mcp-client.ts:157`) before exit — Node's default SIGINT termination skips the `finally` at `run-loop-adapter.ts:597` and orphans MCP servers. Second signal = immediate exit (escape hatch).
3. **Editor fanout teardown** (cleanup #2). `runManifestAndEdit` (`worker.ts:288`): one `AbortController` per fanout; pass `signal` to each `runEditor` `generateText` (`worker.ts:445`); `abort()` when any editor rejects so sibling LLM requests stop burning tokens. Also accept the outer signal from step 1.
4. **Temp-repo leak** (cleanup #3, test-only). `makeTempRepo`: wrap post-`mkdtemp` setup in try/catch → `rm(path, { recursive: true, force: true })` + rethrow.

## Tests
- Unit: `cli.test.ts` — signal present in ctx; abort propagates to flows. `worker.test.ts` — one editor rejecting aborts siblings (mock model observing signal). `temp-repo.test.ts` — failing `git init` (bad PATH stub) leaves no dir.
- Integration: spawn `aitm start` in temp repo, SIGINT mid-run, assert exit path runs MCP close (observable via a stub MCP server) and `{ kind: 'cancelled' }` surfaces.
- Portability: `process.on` signal names identical across Bun/Node/Deno — no `Bun.*`.

## Done when
- Ctrl-C: MCP children reaped, in-flight work aborted, cancelled result reported; no orphan processes.
- Failed editor cancels its siblings.

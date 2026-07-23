# 04 — MCP client & OAuth

> Part of [`overview.md`](overview.md). Depends on: 03 (Disposer/sleep primitives useful here). **Blocked on owner decision: inbound-HTTP scope carve-out (see overview Risks).**
> Findings: [`findings/05-mcp-openrouter-credentials-agent-config.md`](findings/05-mcp-openrouter-credentials-agent-config.md) (mcp/ + oauth sections), [`findings/07-resource-lifecycle-sweep.md`](findings/07-resource-lifecycle-sweep.md) (process items 1-2), [`findings/03-cli-config.md`](findings/03-cli-config.md) (arch 2, portability 1).

## Files to change
- `packages/aitm/src/mcp/mcp-client.ts` — `:76-77` no connect timeout (hang-forever); `:135-149` close not time-boxed, `terminate()` unreachable; `:80-99` pid snapshot lost on mid-handshake failure; `:73` `buildClientConfig` outside try; `:69-101` sequential connects; `:206-209` sanitized-name collisions.
- `packages/aitm/src/mcp/oauth.ts` — missing PKCE (`:282-293,343-348`); unvalidated callback cast (`:234,254-256`); wrong derived server URL (`:325` + `cli/commands.ts:969-971`); template path bug (`:107-109`); `closeAllConnections` (`:199-206`); callbackUrl port ignored (`:272-276`); token response unvalidated (`:362-373`); state-mismatch silent hang (`:237-245`); dead code (`:54-58,222-226,271`).
- `packages/aitm/src/mcp/tool-search.ts:184-186,200` — non-executable deferred tool loop; soft cast.
- `packages/aitm/src/cli/commands.ts:967-987,976` — OAuth endpoint inference belongs in `mcp/oauth.ts`; `.js` import specifier breaks Deno-from-source.
- `packages/aitm/src/templates/*.html` — dead assets (never copied to dist); owner decision: delete + inline fallback, or add build copy step.

## Steps
1. Resolve the scope decision first (inbound-HTTP carve-out in CLAUDE.md vs dropping remote-OAuth). Everything below assumes keep-with-carve-out; if dropped, delete `oauth.ts` + `mcp-login` instead.
2. MCP client: add `connectTimeoutMs`/`closeTimeoutMs` to `McpClientInit`; parallel `Promise.allSettled` connects; move `buildClientConfig` inside try; snapshot pid right after `createClient` resolves; time-box close batch then always `terminate()`; warn on post-sanitization name collisions.
3. OAuth correctness: S256 PKCE pair; validate callback (`code` or `error` present); validate `access_token` non-empty; RFC 8414 metadata discovery replacing hardcoded `/oauth/authorize`+`/oauth/token` (move endpoint derivation from `commands.ts` into `oauth.ts`); pass original server URL through `OAuthOptions`; honor `callbackUrl` port; log state mismatches; `closeAllConnections()` in `stop()`; `fileURLToPath(new URL(...))` inside try; delete dead `detectRuntime`/`ServerImpl`/`rejecter` paths.
4. `tool-search`: distinct "not executable" message for `!baseExecute`; generic wrapper type instead of `as AnyTool`.
5. Fix the dynamic import specifier to `'../mcp/oauth.ts'`.
6. Templates decision: default recommendation — delete HTML files, keep inline `getDefaultHtml`.

## Tests
- Rewrite `oauth.test.ts` against injected server/browser seams (today it spawns a real browser and binds real ports — see findings/05 test item): state validation, callback parsing, PKCE presence, token exchange, timeout, mismatch logging.
- mcp-client: connect timeout expiry closes the client; partial-failure close; name-collision warning.

## Done when
- No MCP/OAuth path can hang the process forever; OAuth is OAuth-2.1-conformant (PKCE + discovery); `mcp-login` works under Deno; zero real network/browser use in unit tests.

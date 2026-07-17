# 01 — Untrusted-repo trust boundary

> Part of [`overview.md`](overview.md). Depends on: none.

Autonomous runs point at arbitrary repos. Everything shipped *in* the target repo (`.ai-task-master/config.json`, `./.mcp.json`, `CLAUDE.md`/`AGENTS.md`, and GitHub review-comment bodies) is attacker-controlled input. Today parts of it steer inference, spawn processes, and enter tool-holding subagent prompts. The trust primitive already exists — `config-loader.ts:165` strips `hooks` from project config — extend it to every other execution-bearing field.

## Files to change
| `file:line` | Problem | Fix |
| --- | --- | --- |
| `config/config-loader.ts:139-144, 346-377` + `credentials/credentials.ts:77-82` | Project `config.json` can set `baseURL`/`openrouterApiKey`; `providerSettings` then sends the user's env `OPENROUTER_API_KEY` as Bearer to an attacker host (inference-redirect + key exfil). | Accept `baseURL`/`openrouterApiKey` **only** from user-owned global config; warn+ignore from project scope, same as `hooks`. |
| `config/config-loader.ts:299-301, 358-363` + `mcp/mcp-client.ts:61-88` | `./.mcp.json` and project `mcpServers` feed `connectAll`, spawning stdio servers with attacker `command`/`args`/`env` — arbitrary code execution. | Gate stdio MCP from project scope behind the user-owned trust boundary (or explicit opt-in). HTTP/SSE-only from project, if any. |
| `config/config-writer.ts:138-168` (`splitKey`) | Missing the `FORBIDDEN_KEY_SEGMENTS` guard that `config/profiles.ts:210-228` has → `config set models.__proto__.polluted …` pollutes `Object.prototype` before schema validation. | Reuse profiles.ts's forbidden-segment rejection in `ConfigWriter`. |
| `config/config-loader.ts:312-319` (`writeSnapshot`) | Snapshot redacts only `openrouterApiKey`; serializes `mcpServers[*].env` + `headers` (bearer tokens) verbatim into `config.snapshot.json`, which the comment calls "safe to inspect." | Redact `mcpServers[*].headers` and `[*].env` in the snapshot. |
| `tools/web-fetch.ts:242-246` + `tools/fetch-html.ts:98-109` | `assertSafeUrl` checks only the initial URL; `fetch(redirect:'follow')` / `curl -L` follow 3xx to `169.254.169.254`/`localhost` unchecked (SSRF). curl also re-resolves DNS (TOCTOU). | `redirect:'manual'`, re-run `assertSafeUrl` per hop; curl `--max-redirs 0` (or resolve+pin+revalidate). |
| `agent-config/expand-imports.ts:166-168` | Per-branch `new Set(visited)` copy → diamond `@`-imports re-inline along every path (~B^depth), each a fresh `readFile`; no aggregate output cap. Hostile CLAUDE.md → memory/CPU blowup. | Global memoized visited set (inline each file once) + cumulative output-byte budget across the whole expansion. |
| `subagents/reviewer.ts:201` (`buildThreadPrompt`) | External reviewer comment bodies interpolated verbatim under "Conversation:"; Reviewer holds `bash`/`writeFile`/`editFile`/`github` → comment can command the agent. | Wrap external bodies in a labeled untrusted-data envelope (fenced `<review-comment>`) + explicit "data not instructions" directive. |
| `subagents/specialist-registry.ts:149` (`composeSpecialistGuidance`) | Target repo's `.claude/agents/*.md` `systemPrompt` concatenated verbatim into a bash/write-tool Worker prompt. Intentional style signal, but unframed. | Frame as advisory guidance placed **below** the immutable contract; note the trust assumption. |

## Steps
1. Extract one trust helper (e.g. `isProjectScoped`/`stripUntrustedProjectFields`) so `baseURL`, `openrouterApiKey`, `mcpServers` (stdio), and existing `hooks` share **one** strip point in `config-loader`. Warn once per ignored field.
2. Resolve the env-vs-file precedence contradiction (finding auth#6, header `config-loader.ts:3` vs impl `:434-473`) as part of #1 — pick user-config-wins, env-fallback, and correct the header to match.
3. Add the forbidden-segment guard to `ConfigWriter.splitKey`; share the constant with `profiles.ts` (no duplication).
4. Redact MCP `env`/`headers` in `writeSnapshot`.
5. SSRF: switch both fetch paths to manual-redirect + per-hop revalidation; cap curl redirects.
6. `expand-imports`: global visited memo + shared byte budget; keep existing containment checks.
7. Reviewer + specialist prompt: untrusted-data envelope / advisory framing via `buildRolePrompt` (coordinate with slice `05`).

## Tests
- Unit: project `config.json` with `baseURL`/`apiKey`/stdio `mcpServers` → resolved config ignores them, warns; global config with same → honored. `config set …__proto__…` throws, `Object.prototype` unpolluted. `writeSnapshot` output contains no MCP secret. `assertSafeUrl` on a public→internal redirect chain rejects. `expand-imports` on a diamond/hostile fixture stays within byte+time budget. Reviewer prompt fixture shows comment body fenced.
- Commands: `bun test`, `bun run test:node`, `bun run typecheck`, `bun run lint`.

## Done when
- Project-scoped `baseURL`/`apiKey`/stdio-MCP are inert (warn+ignore); only user-owned config sets them.
- Prototype pollution via `config set` is rejected; snapshot carries no secrets.
- Redirect-based SSRF is blocked on both fetch paths; hostile import graphs are bounded.
- External comment/specialist text enters subagent prompts as clearly-delimited data, never as bare instructions.

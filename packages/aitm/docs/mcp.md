# MCP

`aitm` is an **MCP client only**. It connects to external MCP servers declared in config and mounts their tools into subagent tool surfaces. It never exposes itself as an MCP server (out of scope per `CLAUDE.md`).

## Config sources

`aitm` discovers `mcpServers` from **four** locations and merges them, so a config that already works in Claude Code works here unchanged. Precedence, lowest → highest (higher entries with the same name shadow lower ones and emit a warning):

1. `~/.claude.json` — Claude Code user scope (`mcpServers` key).
2. `~/.aitm.json` — aitm user scope.
3. `./.mcp.json` — Claude Code project scope, checked into git ([reference](https://code.claude.com/docs/en/mcp)).
4. `./.ai-task-master/config.json` — aitm project scope (final word).

The same shape (a `mcpServers` object keyed by server name) is used everywhere.

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/repo"]
    },
    "github": {
      "type": "http",
      "url": "https://mcp.github.example.com/",
      "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" }
    },
    "sse-api": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

Same shape as Claude Code's `mcpServers` (https://code.claude.com/docs/en/mcp), so a config that works there works here.

## Server naming and collisions

Server names are **sanitized** (non-alphanumeric characters except `-` and `_` replaced with `-`) when constructing the namespaced tool prefix `mcp__<server>__<tool>`. If multiple servers' names sanitize to the same form (e.g., `my.server`, `my server`, `my/server` all become `my-server`), the run will warn on startup:

```
mcp server name collision after sanitization: sanitized=my-server, colliding=[my.server, my server, my/server]
```

To avoid collisions, give servers distinct names that don't collapse under sanitization — e.g., `my-server-v1` and `my-server-v2` instead of `my.server` and `my/server`.

## Transports

| `type` | When | Schema |
| --- | --- | --- |
| `stdio` (default) | Local binary launched as a child process | `command`, `args?`, `env?`, `cwd?` |
| `http` | Production: Streamable HTTP transport | `url`, `headers?` |
| `sse` | Server-Sent Events HTTP transport | `url`, `headers?` |

`stdio` is the default when `type` is omitted — matches Claude Code defaults.

### Project-scoped stdio servers

A `stdio` entry declared in a project-scoped file (`./.mcp.json`, `./.ai-task-master/config.json`) **is honored and spawned**, same as one from user-owned config. That file is where the repo's own Claude Code session already declares those servers, and refusing to run them made `aitm` useless in exactly the repos that ship them — running a checkout's tooling is the operator's decision, taken when they run `aitm start` in it.

This is scoped to MCP. The other project-scope strips still apply: `openrouterApiKey`, `baseURL`, `hooks`, `formatCommand`, `verifyCommand`, and `stylePath` are honored only from `~/.aitm.json` (see `./config.md`), because those redirect the harness itself rather than adding a tool to it.

## Role allowlist

Per-role allowlists scope which servers reach which subagent. Useful for sandboxing — e.g., let `Worker` see the filesystem MCP but not a payments MCP.

```jsonc
{
  "mcpServers": { /* ... */ },
  "mcp": {
    "roleAllowlist": {
      "worker": ["filesystem", "github"],
      "reviewer": ["github"]
    }
  }
}
```

Unlisted servers default to all roles. Optional — most users skip this.

## Deferred tool loading

Mounting a large MCP registry (a GitHub, browser, or database server can expose dozens of tools) would serialize every tool's full JSON schema into every request, on every step — burning context window and per-step cost on schemas the subagent never calls. `mcpDeferToolsOver` bounds that: once a role's MCP tools (beyond the fixed local slots like `readFile`/`bash`) exceed the threshold, the surplus is **deferred** — presented name-only in the system prompt, with schemas absent from requests until fetched.

```jsonc
{
  "mcpServers": { /* ... */ },
  "mcpDeferToolsOver": 20 // default 20; 0 = always defer surplus tools
}
```

At or below the threshold, surplus tools mount directly (full schema) — identical to plain mounting. Above it:

- The system prompt carries a name-only index (`<name>: <first sentence>` per tool) plus a fetch-before-call contract.
- A `tool_search` tool is mounted. `select:mcp__server__tool,…` fetches those exact tools by name; any other query is keyword-ranked over names + descriptions (capped by `max_results`, default 5). Each match's full schema is returned and the tool becomes callable on subsequent steps.
- Calling a deferred tool before fetching its schema returns a typed "fetch it via `tool_search` first" result — never a provider-level error.

Activation is scoped to one subagent invocation; a fresh invocation starts fully deferred again. Applies to the **Worker** and **Reviewer** surfaces (the Planner keeps its read-only trio; the CI-fix session keeps its fixed record). Config-only, resolved project > global. See `src/mcp/tool-search.ts` and `src/loop/run-loop-adapter.ts`.

## Lifecycle

`McpClientManager` (`src/mcp/mcp-client.ts`) owns the lifecycle:

1. `connectAll()` at run start, before any subagent is built.
2. `toolsForRole(role)` returns the merged `ToolSet` for that role; called by the subagent factory.
3. `close()` on exit (success / blocked / SIGINT).

A broken server logs and is skipped — it does not block the run.

### Child processes

Every `stdio` server spawns a local process, and a run must not leave one behind. `StdioProcessRegistry` (`src/mcp/stdio-process-registry.ts`) records each child's pid at connect — including a connect that fails mid-handshake, which is the pid most likely to be orphaned — and reaps them:

- `close()` closes the MCP clients first, then SIGTERMs any child still alive, waits a 2s grace, and SIGKILLs whatever ignored it. The SDK's own cleanup fires a SIGTERM through an abort signal and then forgets the handle, so nothing else verifies the child actually exited.
- A process-exit guard SIGKILLs the remainder synchronously if the run dies without reaching `close()` — the force-quit path (a second Ctrl-C, which exits via `process.exit`).

## Why client-only

Exposing `aitm` as an MCP server would mean shipping an inbound transport surface — out of scope per `CLAUDE.md §"Out of scope for v1"`. As a client, MCP is a clean tool-discovery channel: users plug in capabilities without modifying `aitm` source.

## Cross-links

- `./config.md`
- `./subagents.md`
- `./architecture.md`
- `./vendor/ai-sdk/chunk-15.md` §"Model Context Protocol (MCP)"

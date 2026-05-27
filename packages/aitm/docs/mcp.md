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

## Transports

| `type` | When | Schema |
| --- | --- | --- |
| `stdio` (default) | Local binary launched as a child process | `command`, `args?`, `env?`, `cwd?` |
| `http` | Production: Streamable HTTP transport | `url`, `headers?` |
| `sse` | Server-Sent Events HTTP transport | `url`, `headers?` |

`stdio` is the default when `type` is omitted — matches Claude Code defaults.

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

## Lifecycle

`McpClientManager` (`src/mcp/mcp-client.ts`) owns the lifecycle:

1. `connectAll()` at run start, before any subagent is built.
2. `toolsForRole(role)` returns the merged `ToolSet` for that role; called by the subagent factory.
3. `close()` on exit (success / blocked / SIGINT).

A broken server logs and is skipped — it does not block the run.

## Why client-only

Exposing `aitm` as an MCP server would mean shipping an inbound transport surface — out of scope per `CLAUDE.md §"Out of scope for v1"`. As a client, MCP is a clean tool-discovery channel: users plug in capabilities without modifying `aitm` source.

## Cross-links

- `./config.md`
- `./subagents.md`
- `./architecture.md`
- `./vendor/ai-sdk/chunk-15.md` §"Model Context Protocol (MCP)"

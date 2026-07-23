// Connects to every MCP server declared in `mcpServers` (config) and exposes the
// union of their tools to subagents. The Vercel AI SDK's @ai-sdk/mcp client gives
// us tool-conversion; we wire transport per entry and merge the tool maps.
//
// docs/vendor/ai-sdk/chunk-15.md §"Initializing an MCP Client"
// docs/mcp.md
//
// Lifecycle: connectAll() at run start, toolsForRole() during agent build, close() on exit
// (success / blocked / SIGINT). Failures on individual servers are logged + skipped — a
// broken MCP server should not block the whole run. Every stdio server's child pid is handed to
// StdioProcessRegistry, which outlives close() as the guarantee that none of them zombie.

import { experimental_createMCPClient, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import type { Role } from '../credentials/credentials.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { McpRoleAllowlist, McpRoleAllowlistValue, McpServer, McpServers } from './schema.ts';
import { StdioProcessRegistry } from './stdio-process-registry.ts';

export type TransportKind = 'stdio' | 'http' | 'sse';

export type CreateMcpClient = (config: MCPClientConfig) => Promise<MCPClient>;

// Above this many role-visible MCP tools, the surplus is deferred (name-only stubs + a `tool_search`
// tool) instead of mounted directly, so their JSON schemas stay out of every request (issue #119).
// `0` = always defer. Overridable via the `mcpDeferToolsOver` config key.
export const DEFAULT_MCP_DEFER_TOOLS_OVER = 20;

// The role's MCP tools split by how they enter the agent: `direct` are mounted with full schemas;
// `deferred` are surfaced name-only and fetched on demand through `tool_search` (issue #119).
export type ToolSurface = { direct: ToolSet; deferred: ToolSet };

export type McpClientInit = {
  servers: McpServers;
  // Optional per-role allowlist (issue #115). Per role, either whole servers by name
  // (`{ worker: ['filesystem'] }`) or per-server tool patterns with `*` wildcards
  // (`{ planner: { filesystem: ['read_*', 'list_*'] } }`). Unlisted roles get every connected server.
  roleAllowlist?: McpRoleAllowlist;
  // Defer a role's MCP tools once their count exceeds this (issue #119). Default
  // DEFAULT_MCP_DEFER_TOOLS_OVER; 0 = always defer. See toolSurfaceForRole.
  deferToolsOver?: number;
  // Injection seam for tests — defaults to the AI SDK factory.
  createClient?: CreateMcpClient;
  // Child-process bookkeeping for stdio servers. Injected by tests; production builds its own.
  processes?: StdioProcessRegistry;
  logger?: LoggerLike;
};

type ConnectedServer = {
  name: string;
  transport: TransportKind;
  client: MCPClient;
  tools: ToolSet;
};

export class McpClientManager {
  private readonly createClient: CreateMcpClient;
  private readonly processes: StdioProcessRegistry;
  private servers: ConnectedServer[] = [];

  constructor(private readonly init: McpClientInit) {
    this.createClient = init.createClient ?? experimental_createMCPClient;
    this.processes =
      init.processes ?? new StdioProcessRegistry(init.logger ? { logger: init.logger } : {});
  }

  async connectAll(): Promise<void> {
    for (const [name, server] of Object.entries(this.init.servers)) {
      // Track the client outside the try so a failure during tools() can still
      // close the spawned process / socket instead of leaking it.
      let client: MCPClient | undefined;
      const config = buildClientConfig(name, server);
      try {
        const transport = transportKind(server);
        client = await this.createClient(config);
        const tools = (await client.tools()) as ToolSet;
        this.servers.push({ name, transport, client, tools });
      } catch (err) {
        if (client) {
          try {
            await client.close();
          } catch (closeErr) {
            this.init.logger?.warn('mcp server cleanup failed', {
              name,
              error: errorMessage(closeErr),
            });
          }
        }
        this.init.logger?.warn('mcp server connect failed', {
          name,
          error: errorMessage(err),
        });
      } finally {
        // In `finally`, not the success path: a connect that dies mid-handshake has already spawned
        // the child, and that is exactly the pid most likely to be left behind. Registering an
        // already-dead pid is a no-op — the registry probes liveness before it signals.
        const pid = stdioPid(config.transport);
        if (pid !== undefined) this.processes.register(name, pid);
      }
    }
  }

  // Every tool is mounted under the Claude Code convention `mcp__<server>__<tool>`, so name overlaps
  // across servers no longer collide (both survive as distinct keys — no drop, no warning). The
  // allowlist gates servers (array form) or individual tools (record form) per role (issue #115).
  toolsForRole(role: Role): ToolSet {
    const allowed = this.init.roleAllowlist?.[role];
    const merged: ToolSet = {};
    for (const s of this.servers) {
      const toolFilter = serverToolFilter(allowed, s.name);
      if (toolFilter === null) continue; // this server is not mounted for the role
      for (const [toolName, tool] of Object.entries(s.tools)) {
        if (!toolFilter(toolName)) continue;
        merged[namespacedName(s.name, toolName)] = tool;
      }
    }
    return merged;
  }

  // Split the role's MCP tools into directly-mounted vs. deferred (issue #119). At or below the
  // threshold the whole set is `direct` — byte-identical to plain mounting, no stubs, no tool_search.
  // Above it the whole surplus is `deferred`, surfaced name-only and fetched via tool_search. The
  // fixed local slots (readFile, bash, …) live in the adapter, not here, so every MCP tool counts.
  toolSurfaceForRole(role: Role): ToolSurface {
    const tools = this.toolsForRole(role);
    const threshold = this.init.deferToolsOver ?? DEFAULT_MCP_DEFER_TOOLS_OVER;
    if (Object.keys(tools).length <= threshold) return { direct: tools, deferred: {} };
    return { direct: {}, deferred: tools };
  }

  async close(): Promise<void> {
    const toClose = this.servers;
    this.servers = [];
    await Promise.all(
      toClose.map(async (s) => {
        try {
          await s.client.close();
        } catch (err) {
          this.init.logger?.warn('mcp server close failed', {
            name: s.name,
            error: errorMessage(err),
          });
        }
      }),
    );
    // After the clients: a client.close() that hangs or no-ops must not decide whether the child
    // process survives the run.
    await this.processes.terminate();
  }

  connected(): Array<{ name: string; toolCount: number; transport: string }> {
    return this.servers.map((s) => ({
      name: s.name,
      toolCount: Object.keys(s.tools).length,
      transport: s.transport,
    }));
  }
}

function transportKind(server: McpServer): TransportKind {
  if ('url' in server) return server.type;
  return 'stdio';
}

function buildClientConfig(name: string, server: McpServer): MCPClientConfig {
  if ('url' in server) {
    const transport: MCPClientConfig['transport'] = server.headers
      ? { type: server.type, url: server.url, headers: server.headers }
      : { type: server.type, url: server.url };
    return { transport, clientName: clientNameFor(name) };
  }

  const stdio = new Experimental_StdioMCPTransport({
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
  });
  return { transport: stdio, clientName: clientNameFor(name) };
}

function clientNameFor(name: string): string {
  return `aitm-${name}`;
}

// The spawned child's pid, read off the SDK's stdio transport after connect. The SDK exposes no
// accessor, so this narrows the runtime shape structurally (`in` checks, no casts) and returns
// undefined for every non-stdio transport and for a spawn that never happened.
function stdioPid(transport: MCPClientConfig['transport']): number | undefined {
  if (typeof transport !== 'object' || transport === null) return undefined;
  if (!('process' in transport)) return undefined;
  const proc: unknown = transport.process;
  if (typeof proc !== 'object' || proc === null || !('pid' in proc)) return undefined;
  const pid: unknown = proc.pid;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

// `mcp__<server>__<tool>`, the Claude Code namespacing convention (issue #115). Server names are
// sanitized to the OpenAI-compatible function-name charset; they should avoid `__` so the split back
// to <server>/<tool> stays unambiguous (documented in docs/mcp.md).
function namespacedName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeServerName(serverName)}__${toolName}`;
}

function sanitizeServerName(name: string): string {
  // Collapse any run of 2+ underscores to `-` as well: `__` is the namespace delimiter, so a server
  // name containing it (`my__server`) would make mcpBaseName mis-split `mcp__my__server__tool`.
  return name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/_{2,}/g, '-');
}

// Resolve the per-role, per-server tool gate (issue #115). Returns a predicate over un-namespaced
// tool names, or null when the server is not mounted for the role:
//   allowed undefined        → every server, every tool
//   string[] (whole servers) → this server iff listed, then every tool
//   Record<string,string[]>  → this server iff a key, then tools matching its `*`-glob patterns
function serverToolFilter(
  allowed: McpRoleAllowlistValue | undefined,
  serverName: string,
): ((toolName: string) => boolean) | null {
  if (allowed === undefined) return () => true;
  if (Array.isArray(allowed)) return allowed.includes(serverName) ? () => true : null;
  // Own-property only: a server named `toString`/`__proto__` must not read an inherited member
  // (which would make `.some(...)` throw and abort role resolution).
  const patterns = Object.hasOwn(allowed, serverName) ? allowed[serverName] : undefined;
  if (patterns === undefined) return null;
  return (toolName) => patterns.some((pattern) => matchesGlob(toolName, pattern));
}

// `*` matches any run of characters; every other character is literal (no other metacharacters).
function matchesGlob(name: string, pattern: string): boolean {
  const body = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(name);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

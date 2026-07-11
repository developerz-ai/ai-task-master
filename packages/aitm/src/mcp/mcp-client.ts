// Connects to every MCP server declared in `mcpServers` (config) and exposes the
// union of their tools to subagents. The Vercel AI SDK's @ai-sdk/mcp client gives
// us tool-conversion; we wire transport per entry and merge the tool maps.
//
// docs/vendor/ai-sdk/chunk-15.md §"Initializing an MCP Client"
// docs/mcp.md
//
// Lifecycle: connectAll() at run start, toolsForRole() during agent build, close() on exit
// (success / blocked / SIGINT). Failures on individual servers are logged + skipped — a
// broken MCP server should not block the whole run.

import { experimental_createMCPClient, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import type { Role } from '../credentials/credentials.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { McpRoleAllowlist, McpRoleAllowlistValue, McpServer, McpServers } from './schema.ts';

export type TransportKind = 'stdio' | 'http' | 'sse';

export type CreateMcpClient = (config: MCPClientConfig) => Promise<MCPClient>;

export type McpClientInit = {
  servers: McpServers;
  // Optional per-role allowlist (issue #115). Per role, either whole servers by name
  // (`{ worker: ['filesystem'] }`) or per-server tool patterns with `*` wildcards
  // (`{ planner: { filesystem: ['read_*', 'list_*'] } }`). Unlisted roles get every connected server.
  roleAllowlist?: McpRoleAllowlist;
  // Injection seam for tests — defaults to the AI SDK factory.
  createClient?: CreateMcpClient;
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
  private servers: ConnectedServer[] = [];

  constructor(private readonly init: McpClientInit) {
    this.createClient = init.createClient ?? experimental_createMCPClient;
  }

  async connectAll(): Promise<void> {
    for (const [name, server] of Object.entries(this.init.servers)) {
      // Track the client outside the try so a failure during tools() can still
      // close the spawned process / socket instead of leaking it.
      let client: MCPClient | undefined;
      try {
        const transport = transportKind(server);
        client = await this.createClient(buildClientConfig(name, server));
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

// `mcp__<server>__<tool>`, the Claude Code namespacing convention (issue #115). Server names are
// sanitized to the OpenAI-compatible function-name charset; they should avoid `__` so the split back
// to <server>/<tool> stays unambiguous (documented in docs/mcp.md).
function namespacedName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeServerName(serverName)}__${toolName}`;
}

function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-');
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
  const patterns = allowed[serverName];
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

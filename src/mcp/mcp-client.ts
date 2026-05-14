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
import type { Logger } from '../logger/logger.ts';
import type { McpServer, McpServers } from './schema.ts';

export type TransportKind = 'stdio' | 'http' | 'sse';

export type CreateMcpClient = (config: MCPClientConfig) => Promise<MCPClient>;

export type McpClientInit = {
  servers: McpServers;
  // Optional per-role allowlist: if set, only listed servers are mounted for that role.
  // Example: { worker: ['filesystem'], reviewer: ['git'] }. Unlisted roles get every
  // connected server.
  roleAllowlist?: Partial<Record<Role, string[]>>;
  // Injection seam for tests — defaults to the AI SDK factory.
  createClient?: CreateMcpClient;
  logger?: Logger;
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
      try {
        const transport = transportKind(server);
        const client = await this.createClient(buildClientConfig(name, server));
        const tools = (await client.tools()) as ToolSet;
        this.servers.push({ name, transport, client, tools });
      } catch (err) {
        this.init.logger?.warn('mcp server connect failed', {
          name,
          error: errorMessage(err),
        });
      }
    }
  }

  toolsForRole(role: Role): ToolSet {
    const allowed = this.init.roleAllowlist?.[role];
    const merged: ToolSet = {};
    for (const s of this.servers) {
      if (allowed !== undefined && !allowed.includes(s.name)) continue;
      Object.assign(merged, s.tools);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

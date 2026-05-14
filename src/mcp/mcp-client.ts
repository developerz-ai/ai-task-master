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

import type { ToolSet } from 'ai';
import type { Role } from '../credentials/credentials.ts';
import type { McpServers } from './schema.ts';

export type McpClientInit = {
  servers: McpServers;
  // Optional per-role allowlist: if set, only listed servers are mounted for that role.
  // Example: { worker: ['filesystem'], reviewer: ['git'] }. Unlisted servers default to all roles.
  roleAllowlist?: Partial<Record<Role, string[]>>;
};

export class McpClientManager {
  constructor(private readonly init: McpClientInit) {}

  async connectAll(): Promise<void> {
    throw new Error('not implemented');
  }

  // Returns the merged ToolSet a subagent of `role` should receive. Empty ToolSet if no
  // MCP servers are connected — never throws on "no MCP configured".
  toolsForRole(_role: Role): ToolSet {
    throw new Error('not implemented');
  }

  async close(): Promise<void> {
    throw new Error('not implemented');
  }

  // Diagnostic: list connected servers + how many tools each contributes.
  connected(): Array<{ name: string; toolCount: number; transport: string }> {
    throw new Error('not implemented');
  }
}

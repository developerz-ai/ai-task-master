// MCP *client* config — aitm consumes external MCP servers as additional tool surfaces
// for subagents. aitm is NOT exposed as an MCP server (banned by CLAUDE.md §"Out of scope").
//
// Shape mirrors Claude Code's `mcpServers` config — three transports, same keys.
// Refs:
//   https://code.claude.com/docs/en/mcp                    (Claude Code reference)
//   https://modelcontextprotocol.io/                       (spec)
//   docs/vendor/ai-sdk/chunk-15.md §"Model Context Protocol" (Vercel AI SDK client)
//
// Transports:
//   stdio — local binary launched as a child process. Default when `type` omitted.
//   sse   — HTTP server-sent events. URL + optional headers.
//   http  — Streamable HTTP transport. URL + optional headers. Preferred for production.

import { z } from 'zod';

export const McpStdioServerSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Working directory for the spawned process. Defaults to repo root.
  cwd: z.string().optional(),
});
export type McpStdioServer = z.infer<typeof McpStdioServerSchema>;

export const McpSseServerSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpSseServer = z.infer<typeof McpSseServerSchema>;

export const McpHttpServerSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpHttpServer = z.infer<typeof McpHttpServerSchema>;

export const McpServerSchema = z.union([
  McpStdioServerSchema,
  McpSseServerSchema,
  McpHttpServerSchema,
]);
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpServersSchema = z.record(z.string(), McpServerSchema);
export type McpServers = z.infer<typeof McpServersSchema>;

// Per-role MCP allowlist (issue #115). Two forms per role:
//   string[]                     — whole servers by name (existing behavior)
//   Record<string, string[]>     — per-server un-namespaced tool patterns (`*` wildcard only)
// A role absent from the object gets every connected server. The value union lets a config mix
// forms across roles (e.g. worker whole-server, planner per-tool). See McpClientManager.toolsForRole.
export const McpRoleAllowlistValueSchema = z.union([
  z.array(z.string()),
  z.record(z.string(), z.array(z.string())),
]);
export type McpRoleAllowlistValue = z.infer<typeof McpRoleAllowlistValueSchema>;

export const McpRoleAllowlistSchema = z
  .object({
    planner: McpRoleAllowlistValueSchema.optional(),
    worker: McpRoleAllowlistValueSchema.optional(),
    reviewer: McpRoleAllowlistValueSchema.optional(),
    orchestrator: McpRoleAllowlistValueSchema.optional(),
  })
  // Strict: a misspelled role key (`workre`) must error, not be silently dropped — which would leave
  // that role falling back to every connected server, the opposite of the intended scoping (#115).
  .strict();
export type McpRoleAllowlist = z.infer<typeof McpRoleAllowlistSchema>;

// Reads Claude Code's own MCP config files (~/.claude.json and ./.mcp.json) so aitm can plug into
// the same MCP servers a repo's Claude Code session already uses, without re-declaring them.
// Refs: https://code.claude.com/docs/en/mcp ("Project scope" = .mcp.json in project root;
// "User scope" = ~/.claude.json with an mcpServers key).

import { join } from 'node:path';
import { z } from 'zod';
import { type McpServers, McpServersSchema } from '../mcp/schema.ts';
import { formatZodError, readJsonFile } from './json-file.ts';

const CLAUDE_PROJECT_MCP_FILE = '.mcp.json';
const CLAUDE_USER_FILE = '.claude.json';

// Permissive envelope for Claude Code config files: we only extract `mcpServers` and
// ignore every other key (~/.claude.json especially has many auth/history fields).
const McpEnvelopeSchema = z
  .object({
    mcpServers: McpServersSchema.optional(),
  })
  .passthrough();

// Reads any JSON file whose only field we care about is `mcpServers` (Claude Code's
// .mcp.json or the much larger ~/.claude.json). Missing file → null. Malformed JSON
// is a hard error — we don't want to silently ignore a corrupted user file.
async function readMcpEnvelope(path: string): Promise<McpServers | null> {
  const parsed = await readJsonFile(path);
  if (parsed === undefined) return null;
  const envelope = McpEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new Error(`${path}: ${formatZodError(envelope.error)}`);
  }
  return envelope.data.mcpServers ?? null;
}

// Read Claude Code's project-scoped MCP file (./.mcp.json). Schema is permissive:
// we only extract `mcpServers`, ignore any other keys Claude Code may add.
export async function readClaudeProjectMcp(cwd: string): Promise<McpServers | null> {
  return readMcpEnvelope(join(cwd, CLAUDE_PROJECT_MCP_FILE));
}

// Read Claude Code's user-scoped config (~/.claude.json) and extract the `mcpServers`
// block, if any. ~/.claude.json holds many unrelated keys (auth tokens, history); we
// intentionally read it but only consume `mcpServers`.
export async function readClaudeUserMcp(homeDir: string): Promise<McpServers | null> {
  return readMcpEnvelope(join(homeDir, CLAUDE_USER_FILE));
}

// The Worker's `memory` tool (issue #118): read/write/remove durable per-repo memories rooted at the
// StateStore memory dir. Load-bearing, not a convenience — the Worker's fs tools are confined to its
// worktree (under .ai-task-master/worktrees/<group>/), so the memory dir is otherwise unreachable via
// readFile. Adapter-local glue, like the explore/github slots: the memory dir is an injected path,
// never sourced from MCP.

import {
  MEMORY_TYPES,
  type Memory,
  readMemory,
  removeMemory,
  upsertMemory,
} from '@developerz.ai/ai-claude-compat';
import { type Tool, tool } from 'ai';
import { z } from 'zod';

export const MEMORY_TOOL_NAME = 'memory';

export const memoryInputSchema = z.object({
  action: z
    .enum(['read', 'write', 'remove'])
    .describe('read one memory, write (upsert) one, or remove one'),
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'name must be kebab-case (lowercase, hyphen-separated)')
    .describe('kebab-case memory name; reuse an existing name to UPDATE it in place'),
  description: z.string().optional().describe('one-phrase index description (required for write)'),
  type: z
    .enum(MEMORY_TYPES)
    .optional()
    .describe('memory type (write); project/reference dominate for repo facts'),
  body: z.string().optional().describe('the one-fact body (required for write)'),
});

export type MemoryToolInput = z.infer<typeof memoryInputSchema>;

const MEMORY_TOOL_DESCRIPTION = [
  'Durable per-repo memory that survives across runs — record hard-won repo facts (flaky CI checks,',
  'the real format/verify commands, build quirks) so the next run does not rediscover them.',
  'Write discipline: update-over-duplicate — reuse an existing `name` to update that memory in place;',
  'delete a memory (action "remove") once it is wrong; and never store what the repo already records',
  '(CLAUDE.md, README, config, lockfiles). One fact per memory, kebab-case name.',
].join(' ');

function renderMemory(memory: Memory): string {
  const header = memory.type ? `${memory.name} (${memory.type})` : memory.name;
  return `# ${header}\n${memory.description}\n\n${memory.body}`;
}

export function buildMemoryTool(memoryDir: string): Tool<MemoryToolInput, string> {
  return tool({
    description: MEMORY_TOOL_DESCRIPTION,
    inputSchema: memoryInputSchema,
    execute: async (input): Promise<string> => {
      if (input.action === 'read') {
        const memory = await readMemory(memoryDir, input.name);
        return memory ? renderMemory(memory) : `no memory named "${input.name}"`;
      }
      if (input.action === 'remove') {
        await removeMemory(memoryDir, input.name);
        return `removed memory "${input.name}"`;
      }
      if (input.description === undefined || input.body === undefined) {
        return 'a write needs both a description and a body';
      }
      await upsertMemory(memoryDir, {
        name: input.name,
        description: input.description,
        ...(input.type ? { type: input.type } : {}),
        body: input.body,
      });
      return `saved memory "${input.name}"`;
    },
  });
}

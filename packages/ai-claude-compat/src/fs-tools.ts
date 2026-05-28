// Read/write filesystem tools, modeled on Claude Code's Read/Write. Every tool is scoped to a
// `cwd` (the active worktree) and rejects paths that escape it via the shared `resolveInside`
// guard. AI-SDK `Tool`-shaped so they drop straight into a subagent's tool set.

import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { resolveInside } from './safe-path.ts';

export type ToolInit = {
  // Root the tool is scoped to. Pass an absolute path; everything resolves against it and
  // must stay inside it.
  cwd: string;
};

// offset is a 1-based starting line; limit is the max number of lines to return. Both optional
// — omitting them reads the whole file. Mirrors Claude Code's Read line window.
const readFileInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

// Input types are derived from the schemas so they match `tool()`'s inference exactly (the AI
// SDK's Schema<T> is invariant; a hand-written `offset?: number` won't unify with Zod's
// `number | undefined` under exactOptionalPropertyTypes).
export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type ReadFileOutput = { content: string };
export type WriteFileInput = z.infer<typeof writeFileInputSchema>;
export type WriteFileOutput = { ok: boolean };

export function readFileTool(init: ToolInit): Tool<ReadFileInput, ReadFileOutput> {
  return tool({
    description:
      'Read a UTF-8 text file from the current worktree. Path may be relative (resolved against the worktree root) or absolute (must still be inside the worktree). Optionally pass `offset` (1-based start line) and `limit` (line count) to read a window of a large file.',
    inputSchema: readFileInputSchema,
    execute: async (input: ReadFileInput): Promise<ReadFileOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      const content = await fsReadFile(safe, 'utf8');
      return { content: sliceLines(content, input.offset, input.limit) };
    },
  });
}

export function writeFileTool(init: ToolInit): Tool<WriteFileInput, WriteFileOutput> {
  return tool({
    description:
      'Write a UTF-8 text file inside the current worktree. Creates parent directories. Overwrites any existing file. Path must stay inside the worktree.',
    inputSchema: writeFileInputSchema,
    execute: async (input: WriteFileInput): Promise<WriteFileOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      await mkdir(dirname(safe), { recursive: true });
      await fsWriteFile(safe, input.content, 'utf8');
      return { ok: true };
    },
  });
}

// Return the [offset, offset+limit) line window (1-based offset). No window → whole content.
// A trailing newline is preserved when the window reaches the end of the file.
function sliceLines(content: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return content;
  const lines = content.split('\n');
  const start = offset === undefined ? 0 : offset - 1;
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join('\n');
}

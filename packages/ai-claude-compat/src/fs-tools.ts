// Read/write filesystem tools, modeled on Claude Code's Read/Write. Every tool is scoped to a
// `cwd` (the active worktree) and rejects paths that escape it via the shared `resolveInside`
// guard. AI-SDK `Tool`-shaped so they drop straight into a subagent's tool set.

import { createReadStream } from 'node:fs';
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
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
      // Whole-file read returns the bytes verbatim; a windowed read streams line-by-line so a
      // small window of a huge file doesn't pull the whole thing into memory.
      if (input.offset === undefined && input.limit === undefined) {
        return { content: await fsReadFile(safe, 'utf8') };
      }
      return { content: await readWindow(safe, input.offset, input.limit) };
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

// Stream the [offset, offset+limit) line window (1-based offset) without reading the whole file.
// readline strips line terminators, so when the window runs to the end of the file we re-attach a
// trailing newline — matching the whole-file read for to-EOF windows. A window capped early by
// `limit` returns just the joined lines (no trailing terminator).
async function readWindow(path: string, offset?: number, limit?: number): Promise<string> {
  const start = offset ?? 1;
  const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    const lines: string[] = [];
    let lineNo = 0;
    let cappedEarly = false;
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < start) continue;
      lines.push(line);
      if (limit !== undefined && lines.length >= limit) {
        cappedEarly = true;
        break;
      }
    }
    rl.close();
    const text = lines.join('\n');
    return !cappedEarly && lines.length > 0 ? `${text}\n` : text;
  } finally {
    stream.destroy();
  }
}

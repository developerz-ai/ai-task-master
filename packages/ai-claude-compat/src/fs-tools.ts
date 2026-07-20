// Read/write filesystem tools, modeled on Claude Code's Read/Write. Every tool is scoped to a
// `cwd` (the active worktree) and rejects paths that escape it via the shared `resolveInside`
// guard. AI-SDK `Tool`-shaped so they drop straight into a subagent's tool set.
//
// The file tools share a per-run FileStateTracker (issue #104): Read fingerprints what the model
// saw, Write refuses to clobber an unread file, and Edit (edit-tools.ts) refuses stale/unseen
// content. Output is `cat -n` numbered, windowed to a default of 2000 lines.

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { atomicWriteFile } from './atomic-write.ts';
import { type FileStateTracker, hashContent } from './file-state.ts';
import { resolveInside } from './safe-path.ts';

export type ToolInit = {
  // Root the tool is scoped to. Pass an absolute path; everything resolves against it and
  // must stay inside it.
  cwd: string;
};

// ToolInit plus the run's file-state tracker. REQUIRED (never optional) on the four file tools so
// read-before-edit enforcement can't be silently dropped by forgetting a parameter. grep/glob keep
// the plain ToolInit — they don't touch file state. See issue #104.
export type FileToolInit = ToolInit & { fileState: FileStateTracker };

// Default read window and per-line cap, matching the harness contract.
export const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;

// offset is a 1-based starting line; limit is the max number of lines to return. Both optional —
// omitting `limit` reads a 2000-line window from `offset` (default 1). Mirrors Claude Code's Read.
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

export function readFileTool(init: FileToolInit): Tool<ReadFileInput, ReadFileOutput> {
  return tool({
    description:
      'Read a UTF-8 text file from the current worktree. Path may be relative (resolved against the worktree root) or absolute (must still be inside the worktree). Output is `cat -n` numbered: each line is `<line-number>\\t<content>`. Reads up to 2000 lines by default — pass `offset` (1-based start line) and `limit` to read a specific window; when you already know which part of the file you need, read only that window, as this matters for large files. There is no batch/multi-file read tool — when you need several independent files (or several windows of one file), issue one readFile call per file/window as parallel tool calls in the same turn rather than reading them one round-trip at a time. Do not re-read a file you just edited to verify — the edit result already carries a snippet.',
    inputSchema: readFileInputSchema,
    execute: async (input: ReadFileInput): Promise<ReadFileOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(safe);
      } catch (err) {
        if (isEnoent(err)) return { content: `File not found: ${input.path}` };
        throw err;
      }
      if (st.isDirectory()) {
        return {
          content: `${input.path} is a directory, not a file. Use glob or grep to explore its contents.`,
        };
      }
      if (st.size === 0) {
        // A real (empty) file that was successfully read — record it so a later Write/Edit is allowed.
        init.fileState.record(safe, hashContent(''), 'read');
        return { content: `${input.path} exists but is empty (0 bytes).` };
      }
      const offset = input.offset ?? 1;
      const limit = input.limit ?? DEFAULT_READ_LINES;
      const window = await readNumberedWindow(safe, offset, limit);
      // Fingerprint the WHOLE file even for a windowed read, so a later Edit can tell whether the
      // on-disk content changed since this read. Hash the UTF-8 DECODE (not raw bytes) so it matches
      // what Edit compares (`hashContent(readFile(utf8))`) — otherwise a non-UTF-8-roundtrippable file
      // never agrees between Read and Edit and locks into a permanent stale-read loop (issue #177).
      init.fileState.record(safe, hashContent(await readFile(safe, 'utf8')), 'read');
      return { content: renderReadBody(input.path, window, offset) };
    },
    // The model sees the file content as raw text, not a JSON-escaped `{"content":"…"}` envelope
    // (issue #127) — the `cat -n` window rides inside `content` verbatim.
    toModelOutput: ({ output }) => ({ type: 'text', value: output.content }),
  });
}

export function writeFileTool(init: FileToolInit): Tool<WriteFileInput, WriteFileOutput> {
  return tool({
    description:
      'Write a UTF-8 text file inside the current worktree. Creates parent directories; writes atomically (temp file + rename) and preserves an existing file’s mode. Overwriting an existing file you have not Read this run will fail — Read it first. For partial changes, use the edit tool instead.',
    inputSchema: writeFileInputSchema,
    execute: async (input: WriteFileInput): Promise<WriteFileOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      if (await pathExists(safe)) {
        if (!init.fileState.hasSeen(safe)) {
          throw new Error(
            `Refusing to overwrite ${input.path}: it exists but was not Read this run. Read it first (or use the edit tool for a partial change), then Write.`,
          );
        }
        // A previously-read file that changed on disk since the Read must not be silently clobbered —
        // the same staleness gate the edit tools enforce (issue #187). Hash the UTF-8 decode so it
        // agrees with what Read/Edit record (issue #177). If the file vanished after the existence
        // check, fall through and (re)create it.
        const onDisk = await readIfPresent(safe);
        if (onDisk !== null && init.fileState.isStale(safe, hashContent(onDisk))) {
          throw new Error(
            `${input.path} was modified since you read it — re-read it before overwriting.`,
          );
        }
      }
      await mkdir(dirname(safe), { recursive: true });
      await atomicWriteFile(safe, input.content);
      init.fileState.record(safe, hashContent(input.content), 'write');
      return { ok: true };
    },
    // Plain-text confirmation naming the written path (issue #127).
    toModelOutput: ({ input }) => ({ type: 'text', value: `Wrote ${input.path}` }),
  });
}

type ReadWindow = { lines: string[]; shownTo: number; more: boolean; lastLineNo: number };

// Stream the [offset, offset+limit) line window (1-based), numbering each line `cat -n` style and
// truncating over-long lines. Never holds more than `limit` rendered lines in memory. `more` is
// true when at least one line exists past the window.
async function readNumberedWindow(
  path: string,
  offset: number,
  limit: number,
): Promise<ReadWindow> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    const lines: string[] = [];
    let lineNo = 0;
    let more = false;
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < offset) continue;
      if (lines.length >= limit) {
        more = true;
        break;
      }
      lines.push(`${lineNo}\t${truncateLine(line)}`);
    }
    rl.close();
    return { lines, shownTo: offset + lines.length - 1, more, lastLineNo: lineNo };
  } finally {
    stream.destroy();
  }
}

function renderReadBody(path: string, window: ReadWindow, offset: number): string {
  if (window.lines.length === 0) {
    return `Offset ${offset} is past the last line of ${path} (${window.lastLineNo} lines total).`;
  }
  const text = window.lines.join('\n');
  return window.more
    ? `${text}\n\n[showing lines ${offset}-${window.shownTo}; more remain — continue with offset: ${window.shownTo + 1}]`
    : text;
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated: ${line.length} chars]`
    : line;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

// Read a file's UTF-8 contents, or null if it vanished (ENOENT) between an existence check and this
// read. Any other error propagates.
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

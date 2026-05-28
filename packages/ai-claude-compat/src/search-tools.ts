// Portable search tools, modeled on how Claude Code uses ripgrep + glob — but implemented in
// pure node so there's no `rg` dependency (it may be absent) and no reliance on `fs.glob`
// (not on Node 20). Both walk the tree under a cwd-confined root, skipping `.git` and
// `node_modules`, following no symlinks (which keeps the walk inside the worktree and loop-free).

import { readFile as fsReadFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import type { ToolInit } from './fs-tools.ts';
import { resolveInside } from './safe-path.ts';

const DEFAULT_MAX_RESULTS = 200;
const GLOB_MAX_FILES = 2000;
const MAX_FILE_BYTES = 5_000_000;
// Regex metacharacters escaped to literals when translating a glob (a Set, not a string, so the
// `${` pair doesn't read as a template placeholder).
const REGEX_META = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

const grepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  filesWithMatches: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
});
const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
});

// Input types derived from the schemas so they match `tool()`'s inference exactly (the AI SDK's
// Schema<T> is invariant; hand-written optionals won't unify with Zod's `T | undefined`).
export type GrepInput = z.infer<typeof grepInputSchema>;
// Each match is `relPath:line:text`; with filesWithMatches, each entry is just `relPath`.
export type GrepOutput = { matches: string[]; truncated: boolean };

export type GlobInput = z.infer<typeof globInputSchema>;
export type GlobOutput = { files: string[]; truncated: boolean };

export function grepTool(init: ToolInit): Tool<GrepInput, GrepOutput> {
  return tool({
    description:
      'Search file contents under the worktree for a JavaScript regular expression. Returns `path:line:text` lines (or just file paths with filesWithMatches). Optionally restrict to files matching a glob, ignore case, and cap results.',
    inputSchema: grepInputSchema,
    execute: async (input: GrepInput): Promise<GrepOutput> => {
      const root = await resolveInside(init.cwd, input.path ?? '.');
      const re = compileRegExp(input.pattern, input.ignoreCase ? 'i' : '');
      const fileFilter = input.glob ? globToRegExp(input.glob) : null;
      const cap = input.maxResults ?? DEFAULT_MAX_RESULTS;
      const matches: string[] = [];
      let truncated = false;

      outer: for await (const file of walk(root, init.cwd)) {
        if (fileFilter && !fileFilter.test(file.rel)) continue;
        const text = await readTextOrSkip(file.abs);
        if (text === null) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (!re.test(line)) continue;
          matches.push(input.filesWithMatches ? file.rel : `${file.rel}:${i + 1}:${line}`);
          if (matches.length >= cap) {
            truncated = true;
            break outer;
          }
          if (input.filesWithMatches) continue outer; // one entry per file
        }
      }
      return { matches, truncated };
    },
  });
}

export function globTool(init: ToolInit): Tool<GlobInput, GlobOutput> {
  return tool({
    description:
      'List files under the worktree whose path matches a glob (supports `*`, `**`, `?`). Paths are returned relative to the worktree, sorted. Skips `.git` and `node_modules`.',
    inputSchema: globInputSchema,
    execute: async (input: GlobInput): Promise<GlobOutput> => {
      const root = await resolveInside(init.cwd, input.path ?? '.');
      const re = globToRegExp(input.pattern);
      const files: string[] = [];
      let truncated = false;
      for await (const file of walk(root, init.cwd)) {
        if (!re.test(file.rel)) continue;
        files.push(file.rel);
        if (files.length >= GLOB_MAX_FILES) {
          truncated = true;
          break;
        }
      }
      files.sort();
      return { files, truncated };
    },
  });
}

type WalkedFile = { abs: string; rel: string };

// Depth-first walk yielding regular files only. `rel` is POSIX-style and relative to `cwd`
// (so a caller's glob/regex sees forward slashes regardless of platform). Symlinks are not
// followed — that confines the walk to the worktree and avoids cycles.
async function* walk(dir: string, cwd: string): AsyncGenerator<WalkedFile> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs, cwd);
    } else if (entry.isFile()) {
      yield { abs, rel: relative(cwd, abs).split(sep).join('/') };
    }
  }
}

async function readTextOrSkip(abs: string): Promise<string | null> {
  try {
    const info = await stat(abs);
    if (info.size > MAX_FILE_BYTES) return null;
    const text = await fsReadFile(abs, 'utf8');
    if (text.includes(String.fromCharCode(0))) return null; // crude binary guard: NUL byte
    return text;
  } catch {
    return null;
  }
}

function compileRegExp(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(`invalid regular expression: ${(err as Error).message}`);
  }
}

// Convert a glob to an anchored RegExp. Supports `**` (any run of path segments, incl. zero),
// `*` (any run within one segment), `?` (one non-slash char). Other regex metacharacters are
// escaped so they match literally.
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*'; // `**/` — zero or more directories
        } else {
          re += '.*'; // `**` — anything, including slashes
        }
      } else {
        re += '[^/]*'; // `*` — within a segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c !== undefined && REGEX_META.has(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

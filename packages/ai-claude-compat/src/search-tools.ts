// Portable search tools, modeled on how Claude Code uses ripgrep + glob — but implemented in
// pure node so there's no `rg` dependency (it may be absent) and no reliance on `fs.glob`
// (not on Node 20). Both walk the tree under a cwd-confined root, skipping `.git` and
// `node_modules`, honoring `.gitignore` and skipping hidden directories by default, following no
// symlinks (which keeps the walk inside the worktree and loop-free).

import { readFile as fsReadFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import type { ToolInit } from './fs-tools.ts';
import { type GitignoreRule, isIgnored, parseGitignore } from './gitignore.ts';
import { resolveInside } from './safe-path.ts';
import type { ToolOutputStore } from './tool-output-store.ts';

const DEFAULT_MAX_RESULTS = 200;
const GLOB_MAX_FILES = 2000;
const MAX_FILE_BYTES = 5_000_000;
// A hidden directory that stays visible even without includeHidden — CI workflow files under
// `.github/` are a primary search target for this product.
const HIDDEN_DIR_EXCEPTION = '.github';
// Regex metacharacters escaped to literals when translating a glob (a Set, not a string, so the
// `${` pair doesn't read as a template placeholder). `{` / `}` are handled specially (brace
// alternation) before this set is consulted, and only fall through to literal escaping when unmatched.
const REGEX_META = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

export const grepInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    glob: z
      .string()
      .optional()
      .describe(
        'Restrict to files matching this glob. A slash-free pattern (`*.ts`) matches the basename at any depth; a pattern with a slash (`src/*.ts`, `**/*.ts`) matches the whole worktree-relative path. Supports `*`, `**`, `?`, `{a,b}`.',
      ),
    ignoreCase: z.boolean().optional(),
    filesWithMatches: z.boolean().optional(),
    // Per-file match counts (`path:count`) instead of content. Mutually exclusive with filesWithMatches.
    count: z.boolean().optional(),
    // rg-style context: lines of surrounding source rendered around each match. Ignored in
    // filesWithMatches / count modes.
    contextBefore: z.number().int().nonnegative().optional(),
    contextAfter: z.number().int().nonnegative().optional(),
    // Walk hidden (dot-prefixed) directories too. Default false; `.gitignore` and the `.git` /
    // `node_modules` skips still apply.
    includeHidden: z.boolean().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .refine((v) => !(v.count && v.filesWithMatches), {
    message: 'count and filesWithMatches are mutually exclusive',
  });
export const globInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  includeHidden: z.boolean().optional(),
});

// Input types derived from the schemas so they match `tool()`'s inference exactly (the AI SDK's
// Schema<T> is invariant; hand-written optionals won't unify with Zod's `T | undefined`).
export type GrepInput = z.infer<typeof grepInputSchema>;
// Content mode: `relPath:line:text` (match) and `relPath-line-text` (context), `--` between blocks.
// filesWithMatches: one `relPath` per file. count: one `relPath:count` per file.
// `spillPath` is set only when the result was truncated AND an outputStore was wired: the full
// (capped) result set is also written there so the model can page it instead of re-running the query.
export type GrepOutput = { matches: string[]; truncated: boolean; spillPath?: string };

export type GlobInput = z.infer<typeof globInputSchema>;
export type GlobOutput = { files: string[]; truncated: boolean; spillPath?: string };

// ToolInit plus an optional spill service (issue #127 follow-up): when a grep/glob result is
// truncated, the full (capped) result set is written here and the truncation notice names the
// path, so the model can page it with readFile instead of guessing at a narrower query. Omitted →
// the notice falls back to a plain refine-or-raise-the-limit hint, matching bashTool's degrade path.
export type SearchToolInit = ToolInit & { outputStore?: ToolOutputStore };

export function grepTool(init: SearchToolInit): Tool<GrepInput, GrepOutput> {
  return tool({
    description:
      'Search file contents under the worktree for a JavaScript regular expression. Always use this tool for content search; never invoke `grep` or `rg` through the bash tool. Returns `path:line:text` lines; use `contextBefore`/`contextAfter` for surrounding lines (rendered `path-line-text`), `filesWithMatches` for just paths, or `count` for per-file match counts. Optionally restrict to files matching a glob (supports `{a,b}` alternation), ignore case, include hidden directories, and cap results. Skips `.git`, `node_modules`, and `.gitignore`d paths. There is no batch/multi-query search tool — when you have several independent patterns or paths to search, issue one grep call per query as parallel tool calls in the same turn instead of searching them one round-trip at a time.',
    inputSchema: grepInputSchema,
    execute: async (input: GrepInput): Promise<GrepOutput> => {
      const root = await resolveInside(init.cwd, input.path ?? '.');
      const re = compileRegExp(input.pattern, input.ignoreCase ? 'i' : '');
      const fileFilter = input.glob ? globToRegExp(input.glob) : null;
      const cap = input.maxResults ?? DEFAULT_MAX_RESULTS;
      const before = input.contextBefore ?? 0;
      const after = input.contextAfter ?? 0;
      const withContext = !input.filesWithMatches && !input.count && (before > 0 || after > 0);
      const opts: WalkOptions = { includeHidden: input.includeHidden ?? false };
      const matches: string[] = [];
      let truncated = false;
      let blockEmitted = false;

      // Push a line, returning false once the cap is reached so callers stop. Mirrors the historical
      // "push then check >= cap" truncation semantics.
      const push = (s: string): boolean => {
        matches.push(s);
        if (matches.length >= cap) {
          truncated = true;
          return false;
        }
        return true;
      };

      for await (const file of walk(root, init.cwd, opts)) {
        if (fileFilter && !fileFilter.test(file.rel)) continue;
        const text = await readTextOrSkip(file.abs);
        if (text === null) continue;
        const lines = text.split('\n');
        // A trailing newline yields a phantom empty final element; exclude it so line numbers and
        // context clamping never run past real EOF.
        const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
        const hits: number[] = [];
        for (let i = 0; i < lineCount; i++) {
          if (re.test(lines[i] ?? '')) hits.push(i);
        }
        if (hits.length === 0) continue;

        if (input.filesWithMatches) {
          if (!push(file.rel)) break;
          continue;
        }
        if (input.count) {
          if (!push(`${file.rel}:${hits.length}`)) break;
          continue;
        }
        if (!withContext) {
          let stop = false;
          for (const i of hits) {
            if (!push(`${file.rel}:${i + 1}:${lines[i] ?? ''}`)) {
              stop = true;
              break;
            }
          }
          if (stop) break;
          continue;
        }

        // Context mode: merge overlapping/adjacent context regions into blocks, `--` between blocks.
        const hitSet = new Set(hits);
        let stop = false;
        for (const [start, end] of mergeRegions(hits, before, after, lineCount - 1)) {
          if (blockEmitted && !push('--')) {
            stop = true;
            break;
          }
          blockEmitted = true;
          for (let j = start; j <= end; j++) {
            const sep = hitSet.has(j) ? ':' : '-';
            if (!push(`${file.rel}${sep}${j + 1}${sep}${lines[j] ?? ''}`)) {
              stop = true;
              break;
            }
          }
          if (stop) break;
        }
        if (stop) break;
      }
      const spillPath = truncated
        ? await spillResults(init.outputStore, 'grep', matches)
        : undefined;
      return spillPath === undefined ? { matches, truncated } : { matches, truncated, spillPath };
    },
    // Newline-joined matches as plain text, not a JSON array (issue #127).
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: renderSearchOutput(output.matches, output.truncated, output.spillPath),
    }),
  });
}

// Best-effort spill of a truncated result set to the shared output store (mirrors bashTool's
// capStream degrade path): no store wired, or the write fails, both fall back to `undefined` so the
// caller's notice degrades to the plain refine-or-raise-the-limit hint rather than throwing.
async function spillResults(
  store: ToolOutputStore | undefined,
  tool: string,
  items: readonly string[],
): Promise<string | undefined> {
  if (store === undefined || items.length === 0) return undefined;
  const spilled = await store.save(tool, items.join('\n')).catch(() => null);
  return spilled?.path;
}

// Shared plain-text rendering for grep/glob (issue #127): the entries newline-joined, with an
// explicit truncation notice line only when the result was capped. When a spill path is available
// the notice names it so the model can page the full (capped) result set with readFile instead of
// re-running the query.
function renderSearchOutput(
  items: readonly string[],
  truncated: boolean,
  spillPath?: string,
): string {
  const body = items.length > 0 ? items.join('\n') : '(no matches)';
  if (!truncated) return body;
  const suffix =
    spillPath !== undefined
      ? ` Full output: ${spillPath} — page with readFile(offset/limit) or grep.`
      : '';
  return `${body}\n[results truncated — refine the query or raise the limit.${suffix}]`;
}

export function globTool(init: SearchToolInit): Tool<GlobInput, GlobOutput> {
  return tool({
    description:
      'List files under the worktree whose path matches a glob (supports `*`, `**`, `?`, and `{a,b}` alternation). Paths are returned relative to the worktree, sorted newest-first by modification time (ties broken by path). Skips `.git`, `node_modules`, and `.gitignore`d paths; pass `includeHidden` to walk hidden directories.',
    inputSchema: globInputSchema,
    execute: async (input: GlobInput): Promise<GlobOutput> => {
      const root = await resolveInside(init.cwd, input.path ?? '.');
      const re = globToRegExp(input.pattern);
      const opts: WalkOptions = { includeHidden: input.includeHidden ?? false };
      const collected: WalkedFile[] = [];
      let truncated = false;
      for await (const file of walk(root, init.cwd, opts)) {
        if (!re.test(file.rel)) continue;
        collected.push(file);
        if (collected.length >= GLOB_MAX_FILES) {
          truncated = true;
          break;
        }
      }
      // Sort the collected set newest-first, path-ascending on ties for determinism. mtime is read
      // after collection so the GLOB_MAX_FILES cap still bounds the walk, not the stat count.
      const withMtime = await Promise.all(
        collected.map(async (f) => ({ rel: f.rel, mtimeMs: await mtimeOrZero(f.abs) })),
      );
      withMtime.sort(
        (a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
      );
      const files = withMtime.map((f) => f.rel);
      const spillPath = truncated ? await spillResults(init.outputStore, 'glob', files) : undefined;
      return spillPath === undefined ? { files, truncated } : { files, truncated, spillPath };
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: renderSearchOutput(output.files, output.truncated, output.spillPath),
    }),
  });
}

type WalkedFile = { abs: string; rel: string };
type WalkOptions = { includeHidden: boolean };
// A .gitignore's rules together with the POSIX path (relative to cwd) of the directory holding it.
type GitignoreScope = { baseRel: string; rules: GitignoreRule[] };

// Depth-first walk yielding regular files only. `rel` is POSIX-style and relative to `cwd`
// (so a caller's glob/regex sees forward slashes regardless of platform). Symlinks are not
// followed — that confines the walk to the worktree and avoids cycles. `.gitignore` files
// accumulate down the tree; each applies to paths beneath its own directory.
async function* walk(
  dir: string,
  cwd: string,
  opts: WalkOptions,
  scopes: readonly GitignoreScope[] = [],
): AsyncGenerator<WalkedFile> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  // readdir order is filesystem-dependent; sort so capped grep/glob results (and which entries
  // survive maxResults) stay deterministic across environments.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const dirRel = relative(cwd, dir).split(sep).join('/');

  // A .gitignore in this directory extends the active rule scopes for everything beneath it.
  let active = scopes;
  if (entries.some((e) => e.isFile() && e.name === '.gitignore')) {
    const content = await fsReadFile(join(dir, '.gitignore'), 'utf8').catch(() => null);
    if (content !== null) {
      const rules = parseGitignore(content);
      if (rules.length > 0) active = [...scopes, { baseRel: dirRel, rules }];
    }
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const isDir = entry.isDirectory();
    if (
      isDir &&
      !opts.includeHidden &&
      entry.name.startsWith('.') &&
      entry.name !== HIDDEN_DIR_EXCEPTION
    ) {
      continue;
    }
    const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
    if (ignoredByScopes(active, rel, isDir)) continue;
    const abs = join(dir, entry.name);
    if (isDir) {
      yield* walk(abs, cwd, opts, active);
    } else if (entry.isFile()) {
      yield { abs, rel };
    }
  }
}

function ignoredByScopes(scopes: readonly GitignoreScope[], rel: string, isDir: boolean): boolean {
  for (const scope of scopes) {
    // Every scope's base is an ancestor of `rel` (scopes only accumulate as we descend).
    const relToBase = scope.baseRel === '' ? rel : rel.slice(scope.baseRel.length + 1);
    if (isIgnored(scope.rules, relToBase, isDir)) return true;
  }
  return false;
}

// Merge context regions [hit-before, hit+after] (clamped to [0, lastLine]) for ascending hits;
// regions that overlap or sit one line apart collapse into a single block.
function mergeRegions(
  hits: readonly number[],
  before: number,
  after: number,
  lastLine: number,
): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  for (const h of hits) {
    const start = Math.max(0, h - before);
    const end = Math.min(lastLine, h + after);
    const prev = regions[regions.length - 1];
    if (prev && start <= prev[1] + 1) prev[1] = Math.max(prev[1], end);
    else regions.push([start, end]);
  }
  return regions;
}

async function mtimeOrZero(abs: string): Promise<number> {
  try {
    return (await stat(abs)).mtimeMs;
  } catch {
    return 0;
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
// `*` (any run within one segment), `?` (one non-slash char), and `{a,b}` brace alternation (comma
// split respecting nesting; alternates may hold globs and nested braces). An unmatched `{` stays
// literal. Other regex metacharacters are escaped so they match literally.
export function globToRegExp(glob: string): RegExp {
  // A slash-free pattern (`*.ts`) matches the basename at ANY depth — ripgrep's semantics, the shape
  // models emit most often, and what gitignore.ts already does for unanchored rules. Anchoring it to
  // the whole relative path (`^…$`) silently dropped every nested file (issue #178). A pattern that
  // contains `/` (`src/*.ts`, `**/*.ts`) keeps full-path anchoring.
  const prefix = glob.includes('/') ? '^' : '(?:^|.*/)';
  return new RegExp(`${prefix}${translateGlob(glob)}$`);
}

// Regex body (no anchors) for a glob fragment; recursion handles brace alternates.
function translateGlob(glob: string): string {
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
    } else if (c === '{') {
      const close = findClosingBrace(glob, i);
      if (close === -1) {
        re += '\\{'; // unmatched `{` — literal, preserving pre-brace behavior
      } else {
        const alts = splitTopLevel(glob.slice(i + 1, close));
        re += `(?:${alts.map(translateGlob).join('|')})`;
        i = close;
      }
    } else if (c !== undefined && REGEX_META.has(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
}

// Index of the `}` matching the `{` at `open`, or -1 if there is none (respecting nesting).
function findClosingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++;
    else if (glob[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Split brace-body alternates on top-level commas (commas inside nested braces stay put).
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of body) {
    if (c === '{') {
      depth++;
      current += c;
    } else if (c === '}') {
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

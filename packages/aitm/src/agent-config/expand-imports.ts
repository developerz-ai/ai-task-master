// docs/agent-config-detection.md
// Expand Claude Code `@path` imports inside a CLAUDE.md / AGENTS.md style file, so
// governance that lives in an @-imported file (e.g. `@core/AGENTS.md`) is actually
// seen by the model instead of being fed through as an inert `@core/AGENTS.md` string.
//
// Faithful subset of Claude Code's behavior, with one deliberate hardening: imports are
// contained to `root` (the target repo). Absolute paths, `..` escapes, `~`-home imports,
// and symlinks that resolve outside root are refused (left as literal text) — aitm
// processes untrusted target repos, so an @-import must never read outside the repo.

import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const DEFAULT_MAX_DEPTH = 5;

export type ExpandImportsOptions = {
  // Containment boundary. Imports resolving outside it are left as literal text.
  // Defaults to `baseDir` when omitted.
  root?: string;
  // Maximum nesting levels of @-imports to follow. Defaults to 5.
  maxDepth?: number;
  // Path of the file `contents` was read from. Seeded into the cycle guard so the entry
  // file cannot re-inline itself (e.g. a CLAUDE.md that contains `@./CLAUDE.md`).
  sourcePath?: string;
};

export async function expandImports(
  contents: string,
  baseDir: string,
  options: ExpandImportsOptions = {},
): Promise<string> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  // Containment is enforced against the REAL path of root, so a symlinked root does not
  // reject its own children and — together with the realpath check in inlineImport — a
  // symlinked child cannot escape it.
  const root = await realpathOrResolve(options.root ?? baseDir);
  const visited = new Set<string>();
  if (options.sourcePath !== undefined) {
    const real = await realpathOrNull(options.sourcePath);
    if (real !== null) visited.add(real);
  }
  return expand(contents, baseDir, root, maxDepth, visited);
}

async function realpathOrResolve(p: string): Promise<string> {
  return (await realpathOrNull(p)) ?? resolve(p);
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function expand(
  contents: string,
  baseDir: string,
  root: string,
  depthLeft: number,
  visited: ReadonlySet<string>,
): Promise<string> {
  const lines = contents.split('\n');
  const out: string[] = [];
  let fenceMarker: string | null = null;
  for (const line of lines) {
    const fence = matchFence(line, fenceMarker);
    if (fence.toggled) {
      fenceMarker = fence.marker;
      out.push(line);
      continue;
    }
    if (fenceMarker !== null) {
      out.push(line);
      continue;
    }
    out.push(await expandLine(line, baseDir, root, depthLeft, visited));
  }
  return out.join('\n');
}

// A fenced code block opens/closes on a line whose first non-space run is ``` or ~~~.
// The closing fence must use the same marker character as the opener.
function matchFence(
  line: string,
  current: string | null,
): { toggled: boolean; marker: string | null } {
  const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]?.[0];
  if (marker === undefined) return { toggled: false, marker: current };
  if (current === null) return { toggled: true, marker };
  if (marker === current) return { toggled: true, marker: null };
  return { toggled: false, marker: current };
}

async function expandLine(
  line: string,
  baseDir: string,
  root: string,
  depthLeft: number,
  visited: ReadonlySet<string>,
): Promise<string> {
  // Split on inline code spans (`...`) so imports inside them are not expanded.
  // Odd-indexed segments from this split are the backtick-delimited spans.
  const segments = line.split(/(`+[^`]*`+)/);
  let result = '';
  for (const segment of segments) {
    result += segment.startsWith('`')
      ? segment
      : await expandSegment(segment, baseDir, root, depthLeft, visited);
  }
  return result;
}

async function expandSegment(
  text: string,
  baseDir: string,
  root: string,
  depthLeft: number,
  visited: ReadonlySet<string>,
): Promise<string> {
  // `@path` where `@` starts the segment or follows whitespace, and is not part of an
  // email (`me@host`, whose `@` follows a word char) or an escaped `@@`.
  const re = /(^|\s)@([^\s]+)/g;
  let result = '';
  let last = 0;
  for (const match of text.matchAll(re)) {
    const full = match[0];
    const lead = match[1] ?? '';
    const rawPath = match[2] ?? '';
    const index = match.index ?? 0;
    result += text.slice(last, index);
    last = index + full.length;
    if (rawPath === '' || rawPath.startsWith('@')) {
      result += full;
      continue;
    }
    const inlined = await inlineImport(rawPath, baseDir, root, depthLeft, visited);
    result += inlined === null ? full : lead + inlined;
  }
  result += text.slice(last);
  return result;
}

async function inlineImport(
  rawPath: string,
  baseDir: string,
  root: string,
  depthLeft: number,
  visited: ReadonlySet<string>,
): Promise<string | null> {
  if (depthLeft <= 0) return null;
  const abs = resolveWithinRoot(rawPath, baseDir, root);
  if (abs === null) return null;
  // Re-check containment on the REAL path: a repo-local symlink can be lexically inside
  // root yet point outside it. realpath also serves as the existence check.
  const real = await realpathOrNull(abs);
  if (real === null || !withinRoot(real, root)) return null;
  if (visited.has(real)) return null;
  let fileContents: string;
  try {
    fileContents = await readFile(real, 'utf8');
  } catch {
    return null;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(real);
  return expand(fileContents, dirname(real), root, depthLeft - 1, nextVisited);
}

function resolveWithinRoot(rawPath: string, baseDir: string, root: string): string | null {
  if (rawPath.startsWith('~')) return null;
  const abs = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
  return withinRoot(abs, root) ? abs : null;
}

function withinRoot(abs: string, root: string): boolean {
  const rel = relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

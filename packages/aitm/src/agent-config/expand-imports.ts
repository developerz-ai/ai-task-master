// docs/agent-config-detection.md
// Expand Claude Code `@path` imports inside a CLAUDE.md / AGENTS.md style file, so
// governance that lives in an @-imported file (e.g. `@core/AGENTS.md`) is actually
// seen by the model instead of being fed through as an inert `@core/AGENTS.md` string.
//
// Faithful subset of Claude Code's behavior, with two deliberate hardenings — aitm processes
// untrusted target repos, so an @-import must never read outside the repo and must never let a
// hostile repo exhaust memory/CPU:
//   1. Containment to `root` (the target repo). Absolute paths, `..` escapes, `~`-home imports,
//      and symlinks that resolve outside root are refused (left as literal text).
//   2. Bounded expansion. Each file is inlined at most once across the whole run — a single global
//      memo (which doubles as the cycle guard, no per-branch Set copy) — and a cumulative byte
//      budget caps total inlined content. Together they defeat a hostile @-import fan-out: a
//      diamond/DAG that would otherwise re-expand shared subtrees exponentially.

import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const DEFAULT_MAX_DEPTH = 5;
// Cumulative ceiling on INLINED import bytes (the entry file itself is not charged — it is the
// caller's already-loaded text, not an amplification vector). Past it, further imports are left
// literal. Generous for real governance files (a handful of few-KB imports) yet a hard cap on a
// hostile repo's amplification. Overridable via `maxBytes`.
const DEFAULT_MAX_BYTES = 256 * 1024;

export type ExpandImportsOptions = {
  // Containment boundary. Imports resolving outside it are left as literal text.
  // Defaults to `baseDir` when omitted.
  root?: string;
  // Maximum nesting levels of @-imports to follow. Defaults to 5.
  maxDepth?: number;
  // Cumulative byte budget for inlined import content. Defaults to 256 KiB. Once inlining a file
  // would overflow it, that import (and any after it) is left as literal text.
  maxBytes?: number;
  // Path of the file `contents` was read from. Seeded into the cycle guard so the entry
  // file cannot re-inline itself (e.g. a CLAUDE.md that contains `@./CLAUDE.md`).
  sourcePath?: string;
};

// Invariants + mutable bounds shared across the whole expansion (never copied per branch): the
// global `visited` memo (each real path inlined at most once — also the cycle guard) and the
// `budget` counter (decremented as content is inlined). Both are what keep a hostile fan-out bounded.
type ExpandState = {
  root: string;
  visited: Set<string>;
  budget: number;
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
  const state: ExpandState = { root, visited, budget: options.maxBytes ?? DEFAULT_MAX_BYTES };
  return expand(contents, baseDir, maxDepth, state);
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
  depthLeft: number,
  state: ExpandState,
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
    out.push(await expandLine(line, baseDir, depthLeft, state));
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
  depthLeft: number,
  state: ExpandState,
): Promise<string> {
  // Split on inline code spans (`...`) so imports inside them are not expanded.
  // Odd-indexed segments from this split are the backtick-delimited spans.
  const segments = line.split(/(`+[^`]*`+)/);
  let result = '';
  for (const segment of segments) {
    result += segment.startsWith('`')
      ? segment
      : await expandSegment(segment, baseDir, depthLeft, state);
  }
  return result;
}

async function expandSegment(
  text: string,
  baseDir: string,
  depthLeft: number,
  state: ExpandState,
): Promise<string> {
  // `@path` where `@` starts the segment or follows whitespace, and is not part of an
  // email (`me@host`, whose `@` follows a word char) or an escaped `@@`.
  const re = /(^|\s)@([^\s]+)/g;
  let result = '';
  let last = 0;
  for (const match of text.matchAll(re)) {
    const full = match[0];
    const lead = match[1] ?? '';
    let rawPath = match[2] ?? '';
    const index = match.index ?? 0;
    result += text.slice(last, index);
    // Trim trailing punctuation from the path (e.g., `@guide.` → `@guide`).
    rawPath = rawPath.replace(/[.,;:!?]+$/, '');
    last = index + lead.length + 1 + rawPath.length;
    if (rawPath === '' || rawPath.startsWith('@')) {
      result += full;
      continue;
    }
    const inlined = await inlineImport(rawPath, baseDir, depthLeft, state);
    result += inlined === null ? full : lead + inlined;
  }
  result += text.slice(last);
  return result;
}

async function inlineImport(
  rawPath: string,
  baseDir: string,
  depthLeft: number,
  state: ExpandState,
): Promise<string | null> {
  if (depthLeft <= 0) return null;
  const abs = resolveWithinRoot(rawPath, baseDir, state.root);
  if (abs === null) return null;
  // Re-check containment on the REAL path: a repo-local symlink can be lexically inside
  // root yet point outside it. realpath also serves as the existence check.
  const real = await realpathOrNull(abs);
  if (real === null || !withinRoot(real, state.root)) return null;
  // Global memo: a real path is inlined at most once, so a diamond/DAG of @-imports can never
  // re-expand a shared subtree, and a cycle terminates on re-entry.
  if (state.visited.has(real)) return null;
  let fileContents: string;
  try {
    fileContents = await readFile(real, 'utf8');
  } catch {
    return null;
  }
  // Mark before the budget check so a file whose bytes overflow the (monotonically shrinking)
  // budget is not re-read on every reference — it could never fit later anyway.
  state.visited.add(real);
  const size = byteLength(fileContents);
  if (size > state.budget) return null;
  state.budget -= size;
  return expand(fileContents, dirname(real), depthLeft - 1, state);
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

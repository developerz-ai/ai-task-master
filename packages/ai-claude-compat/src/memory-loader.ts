// Per-repo memory: a directory of one-fact-per-file markdown memories plus a MEMORY.md index
// (issue #118). Durable cross-run knowledge — flaky checks, real verify commands, build quirks —
// that would otherwise be rediscovered from zero every run. Provider-agnostic and dependency-free:
// files are plain markdown with the in-house frontmatter parser, never a YAML engine.
//
// Invariants: the index has exactly one line per memory and is rewritten in the SAME operation as
// any file write/delete, so index and directory never drift; nothing is scaffolded until the first
// write (a missing dir/index reads as empty, never throws).

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord, asString, parseFrontmatter } from './frontmatter.ts';

export const MEMORY_INDEX_FILE = 'MEMORY.md';
const MEMORY_INDEX_HEADER = '# Memory Index';

// Thrown by a write whose name/description can't be safely serialized (empty filename stem, or a line
// break that would corrupt the frontmatter or forge an index row).
export class MemoryValidationError extends Error {
  override readonly name = 'MemoryValidationError';
}

// Per-directory mutex: upsert/remove do a read-modify-write of MEMORY.md, and concurrent group
// Workers (WorkLoop's Promise.all batch) can race. Serialize all mutations for a dir onto one chain so
// the last writer can't drop another's entry. The tail swallows errors so one failure can't wedge it.
const dirLocks = new Map<string, Promise<unknown>>();

function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = dirLocks.get(dir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  dirLocks.set(
    dir,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// Atomic file replace: write a sibling temp file, then rename over the target (rename is atomic on a
// single filesystem). Callers hold the per-dir lock, so a fixed temp suffix never collides.
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

// One index line: the memory file link plus its one-phrase description.
export type MemoryIndexEntry = { file: string; description: string };

// A parsed memory: frontmatter fields plus the fact body.
export type Memory = {
  name: string;
  description: string;
  type?: MemoryType;
  body: string;
};

// Reduce a memory name to a safe kebab-case filename stem — lowercase, non-alphanumerics collapsed
// to single hyphens, trimmed. Keeps writes confined to the memory dir (no path separators survive).
export function memoryFileStem(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function memoryFileName(name: string): string {
  return `${memoryFileStem(name)}.md`;
}

// `- [name](file.md) — description`
const INDEX_LINE = /^- \[[^\]]*\]\(([^)]+)\) — (.*)$/;

function renderIndexLine(name: string, file: string, description: string): string {
  return `- [${name}](${file}) — ${description}`;
}

// null only for a genuinely absent file/dir (ENOENT/ENOTDIR). A permission or transient I/O error is
// rethrown — treating it as "empty" would let a later write rebuild MEMORY.md without its real entries.
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function parseIndex(raw: string): MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = [];
  for (const line of raw.split('\n')) {
    const m = INDEX_LINE.exec(line.trim());
    if (m) entries.push({ file: m[1] ?? '', description: m[2] ?? '' });
  }
  return entries;
}

// Parse MEMORY.md into index entries. A missing dir/file (or one with only a header) → []. Never
// throws for an absent index — a memory dir that isn't there yet is a normal empty state.
export async function loadMemoryIndex(dir: string): Promise<MemoryIndexEntry[]> {
  const raw = await readFileOrNull(join(dir, MEMORY_INDEX_FILE));
  return raw === null ? [] : parseIndex(raw);
}

function coerceType(value: string | undefined): MemoryType | undefined {
  return MEMORY_TYPES.find((t) => t === value);
}

// Read one memory by name (its frontmatter + body). Missing file → null, never throws.
export async function readMemory(dir: string, name: string): Promise<Memory | null> {
  const raw = await readFileOrNull(join(dir, memoryFileName(name)));
  if (raw === null) return null;
  const { data, body } = parseFrontmatter(raw);
  const type = coerceType(asRecord(data.metadata)?.type);
  return {
    name: asString(data.name) || name,
    description: asString(data.description),
    ...(type ? { type } : {}),
    body: body.trim(),
  };
}

function renderMemoryFile(memory: Memory): string {
  const lines = [
    '---',
    `name: ${memory.name}`,
    `description: ${memory.description}`,
    ...(memory.type ? ['metadata:', `  type: ${memory.type}`] : []),
    '---',
    '',
    memory.body.trim(),
    '',
  ];
  return lines.join('\n');
}

// Reject a memory whose name can't form a filename or whose single-line fields carry a line break
// (which would corrupt the frontmatter or forge extra index rows).
function validateMemory(memory: Memory): void {
  if (memoryFileStem(memory.name) === '') {
    throw new MemoryValidationError(
      `memory name "${memory.name}" has no usable filename characters`,
    );
  }
  if (/[\r\n]/.test(memory.name) || /[\r\n]/.test(memory.description)) {
    throw new MemoryValidationError('memory name and description must be single-line');
  }
}

// Write (or update in place) a memory file and keep MEMORY.md in sync in the same operation. A write
// whose name maps to an existing file overwrites that file and its single index line — never a
// duplicate. Creates the memory dir on first write; no scaffold exists before that. Serialized per
// directory and written atomically so concurrent Workers can't drop each other's index entries.
export async function upsertMemory(dir: string, memory: Memory): Promise<void> {
  validateMemory(memory);
  await withDirLock(dir, async () => {
    await mkdir(dir, { recursive: true });
    const file = memoryFileName(memory.name);
    await atomicWrite(join(dir, file), renderMemoryFile(memory));
    const entries = (await loadMemoryIndex(dir)).filter((e) => e.file !== file);
    entries.push({ file, description: memory.description });
    await atomicWrite(join(dir, MEMORY_INDEX_FILE), renderIndexFromEntries(entries));
  });
}

function renderIndexFromEntries(entries: MemoryIndexEntry[]): string {
  const body = entries.map((e) =>
    renderIndexLine(e.file.replace(/\.md$/, ''), e.file, e.description),
  );
  return [MEMORY_INDEX_HEADER, '', ...body, ''].join('\n');
}

// Remove a memory file and its index line together. Serialized per directory. When no index exists
// (uninitialized memory dir) it's a true no-op — the file is best-effort deleted and no index is
// scaffolded — so removing from an empty/absent dir never throws.
export async function removeMemory(dir: string, name: string): Promise<void> {
  await withDirLock(dir, async () => {
    const file = memoryFileName(name);
    await rm(join(dir, file), { force: true });
    const raw = await readFileOrNull(join(dir, MEMORY_INDEX_FILE));
    if (raw === null) return;
    const remaining = parseIndex(raw).filter((e) => e.file !== file);
    await atomicWrite(join(dir, MEMORY_INDEX_FILE), renderIndexFromEntries(remaining));
  });
}

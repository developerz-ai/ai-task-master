// Per-repo memory: a directory of one-fact-per-file markdown memories plus a MEMORY.md index
// (issue #118). Durable cross-run knowledge — flaky checks, real verify commands, build quirks —
// that would otherwise be rediscovered from zero every run. Provider-agnostic and dependency-free:
// files are plain markdown with the in-house frontmatter parser, never a YAML engine.
//
// Invariants: the index has exactly one line per memory and is rewritten in the SAME operation as
// any file write/delete, so index and directory never drift; nothing is scaffolded until the first
// write (a missing dir/index reads as empty, never throws).

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asRecord, asString, parseFrontmatter } from './frontmatter.ts';

export const MEMORY_INDEX_FILE = 'MEMORY.md';
const MEMORY_INDEX_HEADER = '# Memory Index';

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

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// Parse MEMORY.md into index entries. A missing dir/file (or one with only a header) → []. Never
// throws — a memory dir that isn't there yet is a normal empty state, not an error.
export async function loadMemoryIndex(dir: string): Promise<MemoryIndexEntry[]> {
  const raw = await readFileOrNull(join(dir, MEMORY_INDEX_FILE));
  if (raw === null) return [];
  const entries: MemoryIndexEntry[] = [];
  for (const line of raw.split('\n')) {
    const m = INDEX_LINE.exec(line.trim());
    if (m) entries.push({ file: m[1] ?? '', description: m[2] ?? '' });
  }
  return entries;
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

// Write (or update in place) a memory file and keep MEMORY.md in sync in the same operation. A write
// whose name maps to an existing file overwrites that file and its single index line — never a
// duplicate. Creates the memory dir on first write; no scaffold exists before that.
export async function upsertMemory(dir: string, memory: Memory): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = memoryFileName(memory.name);
  await writeFile(join(dir, file), renderMemoryFile(memory), 'utf8');
  const entries = (await loadMemoryIndex(dir)).filter((e) => e.file !== file);
  entries.push({ file, description: memory.description });
  await writeFile(join(dir, MEMORY_INDEX_FILE), renderIndexFromEntries(entries), 'utf8');
}

function renderIndexFromEntries(entries: MemoryIndexEntry[]): string {
  const body = entries.map((e) =>
    renderIndexLine(e.file.replace(/\.md$/, ''), e.file, e.description),
  );
  return [MEMORY_INDEX_HEADER, '', ...body, ''].join('\n');
}

// Remove a memory file and its index line together. A missing file is a no-op (still reconciles the
// index), so removing an already-gone memory never throws.
export async function removeMemory(dir: string, name: string): Promise<void> {
  const file = memoryFileName(name);
  await rm(join(dir, file), { force: true });
  const remaining = (await loadMemoryIndex(dir)).filter((e) => e.file !== file);
  await writeFile(join(dir, MEMORY_INDEX_FILE), renderIndexFromEntries(remaining), 'utf8');
}

// Central spill service for oversized tool output. Bash/grep/glob results that blow past their
// in-context cap must not be destructively truncated — the model may still need the tail. Instead
// the full output is written here and the tool returns a short notice plus the file path, which the
// model then pages with readFile(offset/limit) or grep. One instance per run, sharing a dedicated
// directory (aitm passes `<stateDir>/tool-output/`); the caller runs cleanup() once at run start to
// evict files past the retention window. Pure node:fs/promises — no spawn, no external deps.

import { Buffer } from 'node:buffer';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type SpilledOutput = {
  // Absolute path of the file the full output was written to.
  path: string;
  // UTF-8 byte length of the saved content.
  bytes: number;
  // Number of newline-delimited lines; a final line without a trailing newline still counts.
  lines: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_DAYS = 7;

export class ToolOutputStore {
  private readonly dir: string;
  private counter = 0;

  // `dir` is the directory spill files land in — resolved to an absolute path so the paths returned
  // by save() stay valid regardless of any later cwd change and can be handed straight to readFile.
  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  // Write `content` to a uniquely-named file under the store's directory and return its path plus
  // size stats. The filename encodes an ISO timestamp, the sanitized tool name, and a per-instance
  // counter, so two saves in the same millisecond never collide. Creates the directory on demand.
  async save(tool: string, content: string): Promise<SpilledOutput> {
    const n = ++this.counter;
    await mkdir(this.dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.dir, `${ts}-${slugifyTool(tool)}-${n}.txt`);
    await writeFile(path, content);
    return { path, bytes: Buffer.byteLength(content, 'utf8'), lines: countLines(content) };
  }

  // Best-effort eviction of spill files older than `maxAgeDays`, meant to run once at run start.
  // Returns the count removed. A missing directory (nothing spilled yet) is a no-op; a file that
  // races away between listing and stat is skipped. Only `.txt` spill files are touched.
  async cleanup(maxAgeDays = DEFAULT_MAX_AGE_DAYS): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isEnoent(err)) return 0;
      throw err;
    }
    const cutoff = Date.now() - maxAgeDays * MS_PER_DAY;
    let removed = 0;
    for (const name of entries) {
      if (!name.endsWith('.txt')) continue;
      const path = join(this.dir, name);
      try {
        const info = await stat(path);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await rm(path, { force: true });
          removed += 1;
        }
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
    return removed;
  }
}

function slugifyTool(tool: string): string {
  const slug = tool.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'tool' : slug;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let newlines = 0;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) {
    newlines += 1;
  }
  return content.endsWith('\n') ? newlines : newlines + 1;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

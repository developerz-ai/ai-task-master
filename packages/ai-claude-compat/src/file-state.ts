// File-state tracking for the Claude-Code file contract: records what a subagent has read this run
// so Write can refuse to clobber an unread file and Edit can refuse to apply against content the
// model never saw or that changed on disk since. One instance per subagent run, shared by that
// run's file tools. It holds no file handles — just a map of resolved-path → fingerprint — so the
// tools own all I/O and this stays a pure, testable state machine.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export type FileOp = 'read' | 'write' | 'edit';

type Fingerprint = { contentHash: string; mtimeMs: number; lastOp: FileOp };

export class FileStateTracker {
  private readonly files = new Map<string, Fingerprint>();
  private readonly stale = new Set<string>();

  // Record a file the model has now seen (read) or produced (write/edit). Keyed by resolved
  // absolute path. Clears any prior stale mark — the fingerprint is now current.
  record(absPath: string, contentHash: string, mtimeMs: number, op: FileOp): void {
    this.files.set(absPath, { contentHash, mtimeMs, lastOp: op });
    this.stale.delete(absPath);
  }

  // Has this path been read/written/edited earlier in the run?
  hasSeen(absPath: string): boolean {
    return this.files.has(absPath);
  }

  // True when the path was seen but the current on-disk content hash differs from the recorded one
  // (the file changed since the model read it). An unseen path is not "stale" — callers gate that
  // separately with hasSeen. Marks the path stale so #106 can surface it as a reminder.
  isStale(absPath: string, onDiskContentHash: string): boolean {
    const fp = this.files.get(absPath);
    if (!fp) return false;
    const changed = fp.contentHash !== onDiskContentHash;
    if (changed) this.stale.add(absPath);
    else this.stale.delete(absPath);
    return changed;
  }

  // Paths seen this run whose on-disk content has since diverged from what the model read. Consumed
  // by the system-reminder channel (#106); empty until an isStale check flags one.
  staleFiles(): readonly string[] {
    return [...this.stale];
  }
}

// sha256 of a string's UTF-8 bytes. Matches hashFile for the same text file, so a read-time hash
// (via hashFile) and an edit-time hash (via hashContent on the freshly-read string) compare equal.
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// sha256 of a file's raw bytes, streamed so a huge file is never held in memory at once. Used to
// fingerprint reads (including windowed reads, where the tool only holds a slice of the file).
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

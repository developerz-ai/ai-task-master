// Shared atomic-file primitive. Temp file + fsync + rename + parent-dir fsync, so readers never
// see a half-written file and a crash right after the write can't lose the rename itself.
// Used by ConfigLoader.writeSnapshot, ConfigWriter, StateStore.
//
// Temp name carries a random suffix so concurrent writes to the same path don't
// clobber each other's in-flight temp file. Mode 0o600 keeps secret-bearing
// config files owner-readable only on POSIX.

import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    try {
      await fh.writeFile(contents);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  // The rename already landed — the write is durable data-wise. A failure to additionally fsync the
  // parent dir only risks the rename itself surviving a concurrent OS crash, a much narrower window;
  // it must not report an otherwise-successful write as failed, so warn rather than throw.
  try {
    await fsyncParentDir(dirname(path));
  } catch (err) {
    process.stderr.write(
      `warning: atomic write to ${path} succeeded but parent-dir fsync failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// fsync the directory so the rename (the step that makes the new file visible) is itself durable,
// not just the file's bytes. Best-effort: some platforms/filesystems can't fsync a directory
// handle and say so — Windows (EISDIR/EPERM), network or exotic filesystems (EINVAL/ENOTSUP) —
// and on those the atomic rename alone is the correctness guarantee.
const DIR_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP']);

async function fsyncParentDir(dir: string): Promise<void> {
  let dh: FileHandle | undefined;
  try {
    dh = await open(dir, 'r');
    await dh.sync();
  } catch (err) {
    if (!isDirSyncUnsupported(err)) throw err;
  } finally {
    await dh?.close();
  }
}

function isDirSyncUnsupported(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && DIR_SYNC_UNSUPPORTED.has(code);
}

// Atomic file write: temp file + fsync + rename, so a reader (or a crash) never sees a
// half-written target. Ported from aitm's fs/atomic-write.ts — compat must not import from aitm
// (dependency direction is aitm → compat). Deliberately DIFFERENT from that copy in one way: it
// preserves an existing target's mode (exec bits, group-readability) rather than forcing 0o600 —
// these are the user's own repo files, not secret-bearing config. New files take the umask default.

import { randomUUID } from 'node:crypto';
import { open, rename, rm, stat } from 'node:fs/promises';

export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  // Preserve the target's current mode if it already exists; a new file gets the umask default.
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    // ENOENT (or any stat failure) → treat as a new file; the rename below still surfaces real errors.
  }

  // Random suffix so concurrent writes to the same path don't clobber each other's temp file.
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(contents);
    if (mode !== undefined) await fh.chmod(mode);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

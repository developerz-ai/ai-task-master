// Shared atomic-file primitive. Temp file + fsync + rename so readers never see
// a half-written file. Used by ConfigLoader.writeSnapshot, ConfigWriter, StateStore.
//
// Temp name carries a random suffix so concurrent writes to the same path don't
// clobber each other's in-flight temp file. Mode 0o600 keeps secret-bearing
// config files owner-readable only on POSIX.

import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(contents);
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

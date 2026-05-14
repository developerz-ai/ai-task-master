// Shared atomic-file primitive. Temp file + fsync + rename so readers never see
// a half-written file. Used by ConfigLoader.writeSnapshot, ConfigWriter, StateStore.

import { open, rename } from 'node:fs/promises';

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(contents);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

// Shared test helper: spin up a throwaway git repo in a tempdir.
// Used by *.test.ts (unit) for filesystem-touching cases AND by test/integration/*.test.ts.
// docs/runtime.md §Testing — integration tests run against real temp git repos.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

export type TempRepo = {
  path: string;
  cleanup: () => Promise<void>;
};

export async function makeTempRepo(opts?: { withClaudeMd?: boolean }): Promise<TempRepo> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-test-'));

  await execa('git', ['init'], { cwd: path });
  await execa('git', ['config', 'user.email', 'test@aitm.local'], { cwd: path });
  await execa('git', ['config', 'user.name', 'aitm-test'], { cwd: path });

  if (opts?.withClaudeMd) {
    await writeFile(join(path, 'CLAUDE.md'), '# CLAUDE.md\n');
  }

  const cleanup = async (): Promise<void> => {
    await rm(path, { recursive: true, force: true });
  };

  return { path, cleanup };
}

// docs/commands/config.md, docs/config.md
// Mutates ~/.aitm.json (or, with --project, ./.ai-task-master/config.json) for `aitm config set/unset`.
// Atomic write: temp file + rename. Refuses to write unknown keys.

import type { ConfigFile } from './schema.ts';

export type ConfigScope = 'global' | 'project';

export class ConfigWriter {
  constructor(
    private readonly cwd: string,
    private readonly homeDir: string,
  ) {}

  async set(_scope: ConfigScope, _key: string, _value: unknown): Promise<ConfigFile> {
    throw new Error('not implemented');
  }

  async unset(_scope: ConfigScope, _key: string): Promise<ConfigFile> {
    throw new Error('not implemented');
  }

  async get(_scope: ConfigScope, _key: string): Promise<unknown> {
    throw new Error('not implemented');
  }

  async list(_scope: ConfigScope): Promise<ConfigFile> {
    throw new Error('not implemented');
  }
}

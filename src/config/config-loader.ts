// docs/config.md §"Resolution order", docs/auth.md §"LLM provider"
// Only module allowed to read ~/.aitm.json and .ai-task-master/config.json.
// Merge order: defaults < global < project < env < CLI flags. Frozen snapshot written by writeSnapshot().

import type { CliOverrides, ConfigFile, ResolvedConfig } from './schema.ts';

export class ConfigLoader {
  constructor(
    private readonly cwd: string,
    private readonly homeDir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async resolve(_cliOverrides: CliOverrides): Promise<ResolvedConfig> {
    throw new Error('not implemented');
  }

  async readGlobal(): Promise<ConfigFile | null> {
    throw new Error('not implemented');
  }

  async readProject(): Promise<ConfigFile | null> {
    throw new Error('not implemented');
  }

  async writeSnapshot(_resolved: ResolvedConfig, _stateDir: string): Promise<void> {
    throw new Error('not implemented');
  }
}

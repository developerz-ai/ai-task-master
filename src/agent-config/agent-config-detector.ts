// docs/agent-config-detection.md, docs/coding-style.md
// Style signal only — never selects a provider. Prefer CLAUDE.md over AGENTS.md when both exist.

import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export type AgentConfigFlavor = 'claude' | 'agents' | 'custom';

export type AgentConfig = {
  flavor: AgentConfigFlavor;
  path: string;
  contents: string;
};

export type DetectOptions = {
  stylePath?: string | null;
  prefer?: 'claude' | 'agents';
};

export class AgentConfigDetector {
  constructor(private readonly repoRoot: string) {}

  async detect(options: DetectOptions): Promise<AgentConfig | null> {
    if (options.stylePath) {
      const path = isAbsolute(options.stylePath)
        ? options.stylePath
        : join(this.repoRoot, options.stylePath);
      const contents = await readFile(path, 'utf8');
      return { flavor: 'custom', path, contents };
    }

    const claudePath = join(this.repoRoot, 'CLAUDE.md');
    const agentsPath = join(this.repoRoot, 'AGENTS.md');
    const claude = await readIfExists(claudePath);
    const agents = await readIfExists(agentsPath);

    if (claude !== null && agents !== null) {
      return options.prefer === 'agents'
        ? { flavor: 'agents', path: agentsPath, contents: agents }
        : { flavor: 'claude', path: claudePath, contents: claude };
    }
    if (claude !== null) return { flavor: 'claude', path: claudePath, contents: claude };
    if (agents !== null) return { flavor: 'agents', path: agentsPath, contents: agents };
    return null;
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

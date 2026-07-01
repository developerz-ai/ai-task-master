// docs/agent-config-detection.md, docs/coding-style.md
// Style signal only — never selects a provider. Prefer CLAUDE.md over AGENTS.md when both exist.

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { expandImports } from './expand-imports.ts';

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
        : resolve(this.repoRoot, options.stylePath);
      if (!isAbsolute(options.stylePath)) {
        const rel = relative(this.repoRoot, path);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new Error(`stylePath must remain within repoRoot: ${options.stylePath}`);
        }
      }
      const raw = await readFile(path, 'utf8');
      const contents = await expandImports(raw, dirname(path), {
        root: this.repoRoot,
        sourcePath: path,
      });
      return { flavor: 'custom', path, contents };
    }

    const claudePath = join(this.repoRoot, 'CLAUDE.md');
    const agentsPath = join(this.repoRoot, 'AGENTS.md');
    const claude = await readIfExists(claudePath);
    const agents = await readIfExists(agentsPath);

    const picked = pick(options.prefer, claudePath, claude, agentsPath, agents);
    if (picked === null) return null;
    const contents = await expandImports(picked.raw, this.repoRoot, {
      root: this.repoRoot,
      sourcePath: picked.path,
    });
    return { flavor: picked.flavor, path: picked.path, contents };
  }
}

function pick(
  prefer: 'claude' | 'agents' | undefined,
  claudePath: string,
  claude: string | null,
  agentsPath: string,
  agents: string | null,
): { flavor: AgentConfigFlavor; path: string; raw: string } | null {
  if (claude !== null && agents !== null) {
    return prefer === 'agents'
      ? { flavor: 'agents', path: agentsPath, raw: agents }
      : { flavor: 'claude', path: claudePath, raw: claude };
  }
  if (claude !== null) return { flavor: 'claude', path: claudePath, raw: claude };
  if (agents !== null) return { flavor: 'agents', path: agentsPath, raw: agents };
  return null;
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

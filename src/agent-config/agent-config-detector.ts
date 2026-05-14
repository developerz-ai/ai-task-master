// docs/agent-config-detection.md, docs/coding-style.md
// Style signal only — never selects a provider. Prefer CLAUDE.md over AGENTS.md when both exist.

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

  async detect(_options: DetectOptions): Promise<AgentConfig | null> {
    throw new Error('not implemented');
  }
}

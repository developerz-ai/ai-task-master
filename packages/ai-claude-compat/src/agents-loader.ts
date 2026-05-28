// Discover Claude-Code-style subagent definitions: `<claudeDir>/agents/<name>.md`, each with
// YAML frontmatter (name, description, tools, model) + a markdown body that is the subagent's
// system prompt. Mirrors how the harness scans `.claude/agents/` (see claude-code-knowledge
// skills-and-subagents.md). Also exposes the standard global + project `.claude` locations.

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { asString, asStringArray, parseFrontmatter } from './frontmatter.ts';

export type AgentDefinition = {
  name: string;
  description: string;
  // Tool allowlist from frontmatter; omitted means "all tools".
  tools?: string[];
  // Model override (e.g. sonnet | opus | haiku); omitted means the caller's default.
  model?: string;
  // The markdown body — the subagent's system prompt.
  systemPrompt: string;
  // Absolute path to the definition file.
  path: string;
};

// Load every agent under `<claudeDir>/agents/*.md`. `claudeDir` is a `.claude` directory.
// A missing dir yields []. Sorted by name.
export async function loadAgents(claudeDir: string): Promise<AgentDefinition[]> {
  const agentsDir = join(claudeDir, 'agents');
  const entries = await readdir(agentsDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(agentsDir, entry.name);
    const content = await readFile(path, 'utf8').catch(() => null);
    if (content === null) continue;
    const { data, body } = parseFrontmatter(content);
    const def: AgentDefinition = {
      name: asString(data.name) || basename(entry.name, '.md'),
      description: asString(data.description),
      systemPrompt: body.trim(),
      path,
    };
    const tools = asStringArray(data.tools);
    if (tools) def.tools = tools;
    const model = asString(data.model);
    if (model) def.model = model;
    agents.push(def);
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}

// The two `.claude` locations the harness scans, in increasing precedence: the global
// `~/.claude` first, then the project `<cwd>/.claude`. A caller merging by name should let the
// later (project) entry win.
export function claudeDirs(cwd: string): string[] {
  return [join(homedir(), '.claude'), join(cwd, '.claude')];
}

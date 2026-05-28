// Discover Claude-Code-style skills: `<claudeDir>/skills/<name>/SKILL.md`, each with YAML
// frontmatter (name, description) + a markdown body of instructions. Mirrors how the harness
// scans `.claude/skills/` (see claude-code-knowledge skills-and-subagents.md).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asString, parseFrontmatter } from './frontmatter.ts';

export type SkillDefinition = {
  name: string;
  description: string;
  // The markdown body — the instructions followed when the skill is invoked.
  body: string;
  // Absolute path to the SKILL.md, for reading sibling files the skill references.
  path: string;
};

// Load every skill under `<claudeDir>/skills/*/SKILL.md`. `claudeDir` is a `.claude` directory.
// A missing dir yields []; a skill folder without a SKILL.md is skipped. Sorted by name.
export async function loadSkills(claudeDir: string): Promise<SkillDefinition[]> {
  const skillsDir = join(claudeDir, 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];

  const skills: SkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(skillsDir, entry.name, 'SKILL.md');
    const content = await readFile(path, 'utf8').catch(() => null);
    if (content === null) continue;
    const { data, body } = parseFrontmatter(content);
    skills.push({
      name: asString(data.name) || entry.name,
      description: asString(data.description),
      body: body.trim(),
      path,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// Build the specialist team on the fly when the target repo ships no `.claude/agents/*.md`
// (issue #255). One smart-tier LLM call turns the goal + accepted plan + coding-style digest into
// 2-4 domain agent definitions, persisted under `<stateDir>/agents/*.md` in the same frontmatter
// format `loadAgents` reads — so routing, guidance composition, and resume behave exactly as if
// the repo had shipped them. Repo-shipped agents always win: this module is only consulted when
// discovery found none. Never throws — any failure yields [] and the run proceeds with the
// generic Worker, byte-identical to today.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgentDefinition, loadAgents } from '@developerz.ai/ai-claude-compat';
import { generateText, type LanguageModel, type TimeoutConfiguration } from 'ai';
import type { PrGroup } from '../state/schema.ts';
import { type OnUsage, reportUsage } from './factory.ts';

export type SpecialistBootstrapInit = {
  // Smart-tier handle (the planner's model): team design is a planning judgment, not codegen.
  model: LanguageModel;
  timeout?: TimeoutConfiguration;
  // Recorded under the planner role, like the style digest (#114).
  onUsage?: OnUsage;
  onProgress?: (message: string) => void;
};

export type SpecialistBootstrapInput = {
  goal: string;
  // The accepted plan: group titles + task texts name the domains the team must cover.
  groups: readonly PrGroup[];
  styleDigest?: string;
  // The run's .ai-task-master dir. Generated agents land in `<stateDir>/agents/` — the state dir
  // doubles as the loadAgents "claude dir", and a resume reuses them without a second LLM call.
  stateDir: string;
};

const COMPLETION_MARKER = 'SPECIALISTS_COMPLETE';
const AGENT_DELIM = /^===AGENT\s+([a-z0-9][a-z0-9-]{1,39})===$/m;
const MAX_AGENTS = 4;

// One parsed block of the model's output, before it becomes an on-disk definition.
export type GeneratedSpecialist = { name: string; description: string; guidance: string };

export async function bootstrapSpecialists(
  init: SpecialistBootstrapInit,
  input: SpecialistBootstrapInput,
): Promise<AgentDefinition[]> {
  const cached = await loadAgents(input.stateDir).catch((): AgentDefinition[] => []);
  if (cached.length > 0) return cached;
  try {
    init.onProgress?.('specialists: none in .claude/agents — generating a team for this plan');
    const result = await generateText({
      model: init.model,
      prompt: buildPrompt(input),
      ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
    });
    reportUsage(init.onUsage, result);
    const parsed = parseSpecialists(result.text);
    if (parsed.length === 0) return [];
    await persist(input.stateDir, parsed);
    // Read back through loadAgents so callers get the canonical shape (path, sorted order) —
    // identical to a repo-shipped roster.
    const roster = await loadAgents(input.stateDir);
    init.onProgress?.(
      `specialists: generated ${roster.length} — ${roster.map((a) => a.name).join(', ')}`,
    );
    return roster;
  } catch {
    return [];
  }
}

function buildPrompt(input: SpecialistBootstrapInput): string {
  const planLines = input.groups.map(
    (g) => `- ${g.title}: ${g.tasks.map((t) => t.text).join('; ')}`,
  );
  const style = input.styleDigest?.trim();
  return [
    'Design the smallest team of domain specialist agents (2-4) for the plan below. Each',
    'specialist gets routed PR-group work matching its domain and its guidance is layered onto a',
    'generic coding agent, so write guidance that captures domain-specific judgment (conventions,',
    'pitfalls, verification habits) — not generic "write good code" advice.',
    '',
    `## Goal\n${input.goal}`,
    '',
    `## Plan\n${planLines.join('\n')}`,
    ...(style ? ['', `## Coding style digest\n${style}`] : []),
    '',
    '## Output format (exact)',
    'For each specialist output:',
    '===AGENT <kebab-case-name>===',
    'description: <one sentence naming the domain, keyword-rich — routing matches its words',
    'against task text>',
    '<markdown guidance body, 5-15 lines>',
    '',
    `After the last agent output: ${COMPLETION_MARKER}`,
  ].join('\n');
}

// Parse the delimited blocks, dropping malformed ones rather than failing the batch. Exported for
// unit testing.
export function parseSpecialists(raw: string): GeneratedSpecialist[] {
  const text = raw.replaceAll(COMPLETION_MARKER, '');
  const out: GeneratedSpecialist[] = [];
  const seen = new Set<string>();
  const sections = text.split(/^===AGENT\s+/m).slice(1);
  for (const section of sections) {
    const restored = `===AGENT ${section}`;
    const header = AGENT_DELIM.exec(restored);
    if (!header?.[1]) continue;
    const name = header[1];
    const body = restored.slice((header.index ?? 0) + header[0].length);
    const descMatch = /^\s*description:\s*(.+)$/m.exec(body);
    const description = descMatch?.[1]?.trim() ?? '';
    if (description === '') continue;
    const guidance = body
      .slice((descMatch?.index ?? 0) + (descMatch?.[0]?.length ?? 0))
      .replace(/^===.*$/gm, '')
      .trim();
    if (guidance === '' || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description, guidance });
    if (out.length >= MAX_AGENTS) break;
  }
  return out;
}

async function persist(
  stateDir: string,
  specialists: readonly GeneratedSpecialist[],
): Promise<void> {
  const dir = join(stateDir, 'agents');
  await mkdir(dir, { recursive: true });
  for (const s of specialists) {
    const file = [
      '---',
      `name: ${s.name}`,
      `description: ${s.description}`,
      '---',
      '',
      s.guidance,
      '',
    ].join('\n');
    await writeFile(join(dir, `${s.name}.md`), file);
  }
}

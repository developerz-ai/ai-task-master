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
import type { PrGroup } from '../domain/pr-group.ts';
import { type OnUsage, reportUsage } from './factory.ts';
import { STOPWORDS } from './specialist-registry.ts';

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
// The raw header is captured loosely and normalized in code (sanitizeName): a model that answers
// `===AGENT GraphQL_Schema===` has picked a fine domain and a bad format, and rewriting beats
// dropping the whole specialist.
const AGENT_DELIM = /^===AGENT\s+([^\n=]{1,60}?)\s*===$/m;
const MAX_AGENTS = 4;
// A name is the routing key, weighted ×3 against task text (specialist-registry). Cap it at three
// short domain tokens: longer names dilute the match and read like job titles.
const MAX_NAME_TOKENS = 3;
const MAX_NAME_CHARS = 24;
// Suffixes that carry no domain meaning — every specialist is an agent, so `-agent` discriminates
// nothing. Stripped when the remainder still names a domain; the name is rejected when it doesn't.
const EMPTY_SUFFIXES = ['agent', 'subagent', 'specialist', 'expert', 'helper', 'bot', 'assistant'];
// A description below this is a label, not a router entry — it cannot carry the domain keywords the
// lexical router matches against.
const MIN_DESCRIPTION_CHARS = 40;

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
    const started = Date.now();
    const result = await generateText({
      model: init.model,
      prompt: buildPrompt(input),
      ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
    });
    reportUsage(init.onUsage, result, { latencyMs: Date.now() - started });
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
    '## Naming (the name IS the routing key)',
    'Work is routed to a specialist by matching the words of its name and description against the',
    'task text, with name words weighted far higher. A name that says nothing about a domain routes',
    'nothing.',
    '- lowercase kebab-case, 1-3 words, 24 characters max: `sqlite-migrations`, `graphql-schema`,',
    '  `cli-flags`, `react-forms`',
    "- every word must be a domain term that will literally appear in this plan's task text",
    '- NEVER use: agent, subagent, specialist, expert, engineer, developer, helper, assistant, bot,',
    '  manager, handler, worker, code, coder, senior, master, pro, smart, advanced, general, core',
    '  — `backend-specialist` and `code-expert` name no domain and route nothing; `stripe-webhooks`',
    '  does',
    '- the names must not share a word with each other, or every route is a tie',
    '',
    '## Descriptions (a router entry, not a bio)',
    'One sentence of what it owns, then the triggers, then the boundary:',
    '`Owns <domain>. Use for <4-8 literal keywords from the task text>. Do NOT use for <adjacent',
    'domain> — <the capability limit that makes it wrong>.`',
    'Example: `Owns SQLite schema and migration files. Use for tables, indexes, columns, migrations,',
    'and backfills. Do NOT use for HTTP handlers or CLI flags — it reasons about schema and data',
    'integrity, not transport.`',
    '',
    '## Guidance body (rules, not a bio)',
    'The body is layered onto a generic coding agent that already knows how to write code. Give it',
    'only what is specific to this domain in this repo: 5-15 lines, one imperative rule per line, no',
    'headings, no "## Overview" / "## Responsibilities" / "## Approach", no restating the coding style.',
    'Prefer rules with a concrete referent — a path, a command, a name, a pitfall that has a symptom.',
    '',
    '## Output format (exact)',
    'For each specialist output:',
    '===AGENT <kebab-case-name>===',
    'description: <the one-line router entry described above>',
    '<the rule list, 5-15 lines>',
    '',
    `After the last agent output: ${COMPLETION_MARKER}`,
  ].join('\n');
}

// Normalize a model-emitted name to the routing convention: lowercase kebab-case, meaningless
// suffixes stripped (`stripe-webhooks-agent` → `stripe-webhooks`). Returns '' when nothing routable
// survives — `code-specialist` normalizes to nothing, because both of its words are stopwords the
// router already discards, so the specialist would sit there matching no task at all.
export function sanitizeName(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');
  while (tokens.length > 1 && EMPTY_SUFFIXES.includes(tokens[tokens.length - 1] ?? '')) {
    tokens.pop();
  }
  const routable = tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (routable.length === 0) return '';
  const name = routable.slice(0, MAX_NAME_TOKENS).join('-');
  return name.length <= MAX_NAME_CHARS ? name : '';
}

function nameTokens(name: string): string[] {
  return name.split('-');
}

// Parse the delimited blocks, dropping malformed ones rather than failing the batch. A block is
// dropped when its name carries no routable word, when its description is too thin to route against,
// or when its words are already covered by an accepted specialist (two agents sharing every word are
// a permanent tie — the router would pick between them by sort order). Exported for unit testing.
export function parseSpecialists(raw: string): GeneratedSpecialist[] {
  const text = raw.replaceAll(COMPLETION_MARKER, '');
  const out: GeneratedSpecialist[] = [];
  const seen = new Set<string>();
  const claimed: string[][] = [];
  const sections = text.split(/^===AGENT\s+/m).slice(1);
  for (const section of sections) {
    const restored = `===AGENT ${section}`;
    const header = AGENT_DELIM.exec(restored);
    if (!header?.[1]) continue;
    const name = sanitizeName(header[1]);
    if (name === '' || seen.has(name)) continue;
    const tokens = nameTokens(name);
    if (claimed.some((prior) => tokens.every((t) => prior.includes(t)))) continue;
    const body = restored.slice((header.index ?? 0) + header[0].length);
    const descMatch = /^\s*description:\s*(.+)$/m.exec(body);
    const description = descMatch?.[1]?.trim() ?? '';
    if (description.length < MIN_DESCRIPTION_CHARS) continue;
    const guidance = body
      .slice((descMatch?.index ?? 0) + (descMatch?.[0]?.length ?? 0))
      .replace(/^===.*$/gm, '')
      .trim();
    if (guidance === '') continue;
    seen.add(name);
    claimed.push(tokens);
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

// Distill raw style signals (CLAUDE.md/AGENTS.md/CONTRIBUTING + test globs + config files) into a
// compact markdown digest via one smart-tier LLM call. The digest is injected into planning/work
// prompts instead of the raw style file. SRP: this module only turns signals into a digest — it
// reads signals but never writes (caching is StateStore's job; see plan slice 01).
// Mirrors claudetm core/prompts_coding_style.py (reference behavior, not code).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateText, type LanguageModel } from 'ai';
import type { AgentConfig } from './agent-config-detector.ts';

export type StyleDistillerInit = {
  // Smart-tier handle, e.g. Credentials.modelFor('planner'). Injected so this module stays
  // provider-agnostic (no role/capability knowledge here — that lives in Credentials).
  model: LanguageModel;
};

export type DistillInput = {
  config: AgentConfig | null;
  repoRoot: string;
};

// Test conventions claudetm globs for — surfaced verbatim in the prompt so the digest can describe
// where tests live and how they are named.
export const TEST_GLOBS = ['**/*.test.ts', 'test/integration/**'] as const;

const COMPLETION_MARKER = 'CODING_STYLE_COMPLETE';

const INTRO = [
  "Analyze the project's raw style signals below and produce a concise coding guide (under 600",
  'words). This digest is injected into every planning and work prompt, so keep it short and',
  'actionable. Do NOT write files — OUTPUT the guide as markdown text only.',
].join('\n');

const OUTPUT_FORMAT = [
  '## Output format',
  'Output a markdown guide starting with `# Coding Style`. Include these sections, skipping any',
  'that do not apply:',
  '- **Workflow** — TDD? required gates/checks before commit?',
  '- **Code Style** — naming, formatting, imports (2-4 bullets)',
  '- **Testing** — CRITICAL: exact paths, naming patterns, run commands, example files',
  '- **Project-Specific** — unique requirements from CLAUDE.md / AGENTS.md',
  '',
  `End with: \`${COMPLETION_MARKER}\``,
].join('\n');

type Signal = { label: string; body: string };

export class StyleDistiller {
  constructor(private readonly init: StyleDistillerInit) {}

  // Never throws: a missing signal, an unreadable file, or a model error all degrade to the raw
  // style contents (or empty) so a flaky style step can never block the run.
  async distill(input: DistillInput): Promise<string> {
    const fallback = input.config?.contents ?? '';
    const signals = await gatherSignals(input);
    if (signals.length === 0) return fallback;
    try {
      const { text } = await generateText({
        model: this.init.model,
        prompt: buildPrompt(signals),
      });
      const digest = cleanDigest(text);
      return digest === '' ? fallback : digest;
    } catch {
      return fallback;
    }
  }
}

async function gatherSignals(input: DistillInput): Promise<Signal[]> {
  const { config, repoRoot } = input;
  const signals: Signal[] = [];

  if (config) {
    signals.push({
      label: `Project style file (${config.flavor}: ${config.path})`,
      body: config.contents,
    });
  }

  const contributing = await readIfPresent(join(repoRoot, 'CONTRIBUTING.md'));
  if (contributing !== null) signals.push({ label: 'CONTRIBUTING.md', body: contributing });

  for (const block of await gatherConfigFiles(repoRoot)) signals.push(block);

  const scripts = await readPackageScripts(repoRoot);
  if (scripts !== null) signals.push({ label: 'package.json scripts', body: scripts });

  return signals;
}

// Top-level formatter/linter + compiler config drives the Code Style section. Picks `biome.json`
// and every `tsconfig*.json` at the repo root (a monorepo may ship several).
async function gatherConfigFiles(repoRoot: string): Promise<Signal[]> {
  const names = await readdir(repoRoot).catch((): string[] => []);
  const picked = names
    .filter((name) => name === 'biome.json' || /^tsconfig.*\.json$/.test(name))
    .sort();
  const blocks: Signal[] = [];
  for (const name of picked) {
    const body = await readIfPresent(join(repoRoot, name));
    if (body !== null) blocks.push({ label: name, body });
  }
  return blocks;
}

async function readPackageScripts(repoRoot: string): Promise<string | null> {
  const raw = await readIfPresent(join(repoRoot, 'package.json'));
  return raw === null ? null : extractScripts(raw);
}

function extractScripts(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) return null;
  const scripts: unknown = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return null;
  return JSON.stringify(scripts, null, 2);
}

function buildPrompt(signals: Signal[]): string {
  const blocks = signals
    .map((s) => `----- BEGIN ${s.label} -----\n${s.body}\n----- END ${s.label} -----`)
    .join('\n\n');
  return [
    INTRO,
    '',
    '## Raw style signals',
    blocks,
    '',
    `Test file globs to account for: ${TEST_GLOBS.join(', ')}`,
    '',
    OUTPUT_FORMAT,
  ].join('\n');
}

// Mirror of claudetm extract_coding_style: drop the completion marker, then return from the
// `# Coding Style` header onward (case-insensitive); wrap headerless output so callers always get
// a guide that starts with the canonical header.
function cleanDigest(raw: string): string {
  const content = raw.replaceAll(COMPLETION_MARKER, '').trim();
  if (content === '') return '';
  const idx = content.toLowerCase().indexOf('# coding style');
  if (idx >= 0) return content.slice(idx).trim();
  return `# Coding Style\n\n${content}`;
}

async function readIfPresent(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((): null => null);
}

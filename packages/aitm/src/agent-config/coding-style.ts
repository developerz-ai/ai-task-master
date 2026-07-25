// Build the coding-style guide injected into planning and work prompts. Two halves, in this order:
//   1. the project's own CLAUDE.md/AGENTS.md, VERBATIM — it is the repo's house rules, and a
//      summarizer silently drops rules ("no default exports", "tests must pass under Node too"),
//      which is how an agent ends up violating a file it was told to follow;
//   2. a distilled digest from one smart-tier LLM call, whose job is the conventions the style file
//      does NOT state — where tests live, how they run, what the formatter/compiler enforce.
// SRP: this module only turns signals into that guide — it reads signals but never writes (caching is
// StateStore's job; see plan slice 01).
// Mirrors claudetm core/prompts_coding_style.py (reference behavior, not code).

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { generateText, type LanguageModel, type TimeoutConfiguration } from 'ai';
import { type OnUsage, reportUsage } from '../observability/usage-sink.ts';
import type { AgentConfig } from './agent-config-detector.ts';

export type StyleDistillerInit = {
  // Smart-tier handle, e.g. Credentials.modelFor('planner'). Injected so this module stays
  // provider-agnostic (no role/capability knowledge here — that lives in Credentials).
  model: LanguageModel;
  // Per-step LLM request deadline (issue #129). Unset → no deadline. On expiry the SDK aborts and
  // the existing catch degrades to the raw style contents — a stalled style step never hangs the run.
  timeout?: TimeoutConfiguration;
  // Usage sink for the style-digest call, recorded under the planner role (#114). It runs on the
  // planner's model. Unset → no accounting.
  onUsage?: OnUsage;
  // Progress sink fired ONCE per distill call, right before the LLM call (slice 01b): names the
  // signals feeding the digest so a silent pre-planning pause reads as `coding style: distilling
  // from <labels>` instead of nothing. Never per-signal — a repo with many config files must not
  // spam the stream. Provider-agnostic module: an injected callback, not a direct console import,
  // keeps this module decoupled from any particular output format.
  onProgress?: (message: string) => void;
};

export type DistillInput = {
  config: AgentConfig | null;
  repoRoot: string;
};

// Test conventions surfaced verbatim in the prompt so the digest can describe where tests live and
// how they are named. Only the universal paired-`*.test.ts` convention is hardcoded; a fixed
// directory layout would bias codegen for target repos that organize tests differently.
export const TEST_GLOBS = ['**/*.test.ts'] as const;

const COMPLETION_MARKER = 'CODING_STYLE_COMPLETE';

const INTRO = [
  "Analyze the project's raw style signals below and produce a concise coding guide (under 600",
  'words). This digest is injected into every planning and work prompt, so keep it short and',
  'actionable. Do NOT write files — OUTPUT the guide as markdown text only.',
  '',
  'The project style file (CLAUDE.md / AGENTS.md) is injected verbatim alongside your digest, so do',
  'NOT restate or summarize its rules — the agent already has them. Your job is the conventions it',
  'does not spell out: the patterns actually visible in the config files and scripts below (where',
  'tests live and how they are named, the commands that gate a commit, what the formatter and',
  'compiler enforce). Concrete paths and commands beat prose.',
].join('\n');

const OUTPUT_FORMAT = [
  '## Output format',
  'Output a markdown guide starting with `# Coding Style`. Include these sections, skipping any',
  'that do not apply:',
  '- **Workflow** — TDD? required gates/checks before commit?',
  '- **Code Style** — naming, formatting, imports the tooling enforces (2-4 bullets)',
  '- **Testing** — CRITICAL: exact paths, naming patterns, run commands, example files',
  '- **Patterns** — conventions to imitate that the style file does not state',
  '',
  `End with: \`${COMPLETION_MARKER}\``,
].join('\n');

type Signal = { label: string; body: string };

// Fire the coarse `distilling from <labels>` line once per distill call. Swallows a throwing sink —
// observability must never break the distill pass.
function reportProgress(
  onProgress: StyleDistillerInit['onProgress'],
  signals: readonly Signal[],
): void {
  if (!onProgress) return;
  try {
    onProgress(`coding style: distilling from ${signals.map((s) => s.label).join(', ')}`);
  } catch {
    // observability must never break distillation
  }
}

export class StyleDistiller {
  constructor(private readonly init: StyleDistillerInit) {}

  // Returns the digest alone — the verbatim style file is composed back in by composeStyleGuide, so
  // a cached digest from an earlier run still gets today's CLAUDE.md. Never throws: a missing signal,
  // an unreadable file, or a model error all degrade to '' so a flaky style step can never block the
  // run (the verbatim half still reaches every prompt).
  async distill(input: DistillInput): Promise<string> {
    const signals = await gatherSignals(input);
    if (signals.length === 0) return '';
    reportProgress(this.init.onProgress, signals);
    try {
      const started = Date.now();
      const result = await generateText({
        model: this.init.model,
        prompt: buildPrompt(signals),
        ...(this.init.timeout !== undefined ? { timeout: this.init.timeout } : {}),
      });
      reportUsage(this.init.onUsage, result, { latencyMs: Date.now() - started });
      return cleanDigest(result.text);
    } catch {
      return '';
    }
  }
}

// The guide handed to every planner/worker/editor/reviewer prompt: the project style file verbatim,
// then the digest. The verbatim half leads because it is authoritative and because the one cap that
// truncates this string (the editor leaf's, worker.ts) keeps the head. Either half may be missing;
// both missing → '' and the style block is omitted entirely.
export function composeStyleGuide(config: AgentConfig | null, digest: string): string {
  const parts: string[] = [];
  const contents = config?.contents.trim() ?? '';
  if (config && contents !== '') {
    parts.push(
      `# ${basename(config.path)} (project style file, verbatim — authoritative)\n\n${contents}`,
    );
  }
  const trimmed = digest.trim();
  if (trimmed !== '') parts.push(trimmed);
  return parts.join('\n\n');
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

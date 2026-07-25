// Build the coding-style guide injected into planning and work prompts. Two halves, in this order:
//   1. the project's own CLAUDE.md/AGENTS.md, VERBATIM — it is the repo's house rules, and a
//      summarizer silently drops rules ("no default exports", "tests must pass under Node too"),
//      which is how an agent ends up violating a file it was told to follow;
//   2. a distilled digest from one smart-tier LLM call, whose job is the conventions the style file
//      does NOT state — where tests live, how they run, what the formatter/compiler enforce.
// SRP: this module only turns signals into that guide — it reads signals but never writes (caching is
// StateStore's job; see plan slice 01).
// Mirrors claudetm core/prompts_coding_style.py (reference behavior, not code).

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { withTimeout } from '@developerz.ai/ai-claude-compat';
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

// How much real code the digest gets to look at. The config files alone cannot show naming, error
// handling, or module shape — and on a repo with no biome/tsconfig/package.json they showed nothing
// at all, so a Rust or Python project got an empty digest. Bounded hard: style detection runs before
// every plan, and must never become a filesystem crawl or a token sink.
export const SOURCE_SAMPLE_LIMIT = 5;
export const TEST_SAMPLE_LIMIT = 3;
export const SAMPLE_CHAR_LIMIT = 2500;
const MAX_WALK_FILES = 4000;
const MAX_WALK_DEPTH = 8;

// Directories that never teach conventions and can be enormous.
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  'venv',
  '__pycache__',
  'out',
  'Pods',
  'tmp',
  'testdata',
  'fixtures',
  'snapshots',
]);

// Source extensions across the ecosystems aitm is pointed at. Adding one here is what gives that
// language a style digest — the previous JS-only signal set silently produced none.
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.py',
  '.go',
  '.rb',
  '.java',
  '.kt',
  '.kts',
  '.php',
  '.cs',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.ex',
  '.exs',
  '.scala',
  '.sh',
  '.sql',
  '.vue',
  '.svelte',
]);

// Repo-root config that reveals conventions, across ecosystems — not just the JS trio.
const CONFIG_FILE_PATTERNS: readonly RegExp[] = [
  /^biome\.jsonc?$/,
  /^tsconfig.*\.json$/,
  /^\.eslintrc.*$/,
  /^\.prettierrc.*$/,
  /^Cargo\.toml$/,
  /^rustfmt\.toml$/,
  /^clippy\.toml$/,
  /^pyproject\.toml$/,
  /^setup\.cfg$/,
  /^ruff\.toml$/,
  /^go\.mod$/,
  /^\.golangci\.(ya?ml|toml)$/,
  /^Gemfile$/,
  /^\.rubocop\.ya?ml$/,
  /^composer\.json$/,
  /^Makefile$/,
  /^justfile$/,
  /^\.editorconfig$/,
];

const COMPLETION_MARKER = 'CODING_STYLE_COMPLETE';

const INTRO = [
  "Analyze the project's raw style signals below and produce a concise coding guide (under 600",
  'words). This digest is injected into every planning and work prompt, so keep it short and',
  'actionable. Do NOT write files — OUTPUT the guide as markdown text only.',
  '',
  'The project style file (CLAUDE.md / AGENTS.md) is injected verbatim alongside your digest, so do',
  'NOT restate or summarize its rules — the agent already has them. Your job is the conventions it',
  'does not spell out: the patterns actually visible in the config files, scripts, and REAL SOURCE',
  'FILES below (naming, error handling, module shape, where tests live and how they are named, the',
  'commands that gate a commit). Concrete paths and commands beat prose.',
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
      const result = await generateText(
        withTimeout({ model: this.init.model, prompt: buildPrompt(signals) }, this.init.timeout),
      );
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

  for (const block of await gatherSourceSamples(repoRoot)) signals.push(block);

  return signals;
}

// Real code from the repo — the half the config files cannot show. Sources and tests are separate
// signals so the digest can speak to each, and each is ONE signal holding several excerpts so the
// progress line stays a line instead of a file listing.
async function gatherSourceSamples(repoRoot: string): Promise<Signal[]> {
  const files = await walkSourceFiles(repoRoot);
  if (files.length === 0) return [];
  const sized = await Promise.all(
    files.map(async (path) => ({
      path,
      size: (await stat(path).catch(() => null))?.size ?? 0,
    })),
  );
  const tests = sized.filter((f) => isTestPath(relative(repoRoot, f.path)));
  const sources = sized.filter((f) => !isTestPath(relative(repoRoot, f.path)));
  const signals: Signal[] = [];
  const source = await renderSamples(repoRoot, pickSamples(sources, SOURCE_SAMPLE_LIMIT));
  if (source !== null) signals.push({ label: 'source samples', body: source });
  const test = await renderSamples(repoRoot, pickSamples(tests, TEST_SAMPLE_LIMIT));
  if (test !== null) signals.push({ label: 'test samples', body: test });
  return signals;
}

// Biggest first: a large file shows more of a codebase's conventions than a barrel or a stub. Ties
// break on path so the same repo always yields the same digest inputs.
function pickSamples(
  candidates: ReadonlyArray<{ path: string; size: number }>,
  limit: number,
): Array<{ path: string; size: number }> {
  return [...candidates]
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, limit);
}

async function renderSamples(
  repoRoot: string,
  picked: ReadonlyArray<{ path: string }>,
): Promise<string | null> {
  const blocks: string[] = [];
  for (const file of picked) {
    const body = await readIfPresent(file.path);
    if (body === null || body.trim() === '') continue;
    blocks.push(`--- ${relative(repoRoot, file.path)} ---\n${body.slice(0, SAMPLE_CHAR_LIMIT)}`);
  }
  return blocks.length === 0 ? null : blocks.join('\n\n');
}

// A path is a test by the conventions every ecosystem actually uses: a `test`/`spec` directory, a
// `*.test.*` / `*_test.*` suffix, or a `test_*` prefix.
export function isTestPath(relPath: string): boolean {
  const lower = relPath.toLowerCase().replaceAll('\\\\', '/');
  const base = lower.split('/').pop() ?? lower;
  if (
    lower
      .split('/')
      .slice(0, -1)
      .some((seg) => /^(tests?|specs?)$/.test(seg))
  )
    return true;
  return /[._-](test|spec)\./.test(base) || /^test_/.test(base) || /_(test|spec)\./.test(base);
}

// Breadth-first, bounded on both depth and total files so a monorepo cannot stall the pre-plan step.
// Hidden directories are skipped wholesale — `.git` alone would dwarf the repo.
async function walkSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && found.length < MAX_WALK_FILES) {
    const next = queue.shift();
    if (!next) break;
    const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && next.depth < MAX_WALK_DEPTH) {
          queue.push({ dir: full, depth: next.depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        found.push(full);
        if (found.length >= MAX_WALK_FILES) break;
      }
    }
  }
  return found;
}

// Top-level formatter/linter/build config drives the Code Style section, across ecosystems (a
// monorepo may ship several matches).
async function gatherConfigFiles(repoRoot: string): Promise<Signal[]> {
  const names = await readdir(repoRoot).catch((): string[] => []);
  const picked = names.filter((name) => CONFIG_FILE_PATTERNS.some((re) => re.test(name))).sort();
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
  return [INTRO, '', '## Raw style signals', blocks, '', OUTPUT_FORMAT].join('\n');
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

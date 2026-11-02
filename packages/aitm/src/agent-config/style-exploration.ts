// Bounded, read-only repository exploration for the coding-style distiller.
//
// The deterministic signal bundle (the project style file, CONTRIBUTING.md, root config files,
// package.json scripts, source/test samples) cannot see conventions held in files it does not
// cover — a repo whose only style doc is docs/STYLE.md produced an empty digest, because the
// bundle never looks there. This module hands the distiller ONE tool so the model can read such
// a file itself.
//
// Read-only by construction: the tool set holds exactly one tool, it reads a UTF-8 file and
// nothing else — no write, no edit, no command, no directory listing. Every path is contained in
// the repo root by compat's shared `resolveInside`, the same guard the FS tools use against the
// user's real checkout: it refuses `..` traversal AND symlinks that resolve outside the root.

import { open, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { resolveInside } from '@developerz.ai/ai-claude-compat';
import { type Tool, tool } from 'ai';
import { z } from 'zod';

// The exploration is a pre-flight look at the repo, not a work session: ten model steps is enough
// to read a couple of convention files and still leave the digest itself a step. It caps THIS
// exploration only — the subagent step budgets (EDITOR_MAX_STEPS, …) are untouched.
export const STYLE_EXPLORATION_MAX_STEPS = 10;

// An explored file is a convention doc, not a source dump: past this the extra text costs tokens
// without adding conventions. Over the cap the file is TRUNCATED with a marker, never refused —
// a partially read style guide still says more than none.
export const STYLE_EXPLORATION_MAX_FILE_BYTES = 12_000;

const TRUNCATION_MARKER = '\n\n[truncated — the file is longer than the exploration byte cap]';

const readRepoFileInputSchema = z.object({ path: z.string() });

export type ReadRepoFileInput = z.infer<typeof readRepoFileInputSchema>;

// The tool set the distiller offers: exactly ONE tool, and it only reads.
export type StyleExplorationTools = {
  readRepoFile: Tool<ReadRepoFileInput, string>;
};

export function styleExplorationTools(repoRoot: string): StyleExplorationTools {
  return {
    readRepoFile: tool({
      description: [
        'Read one UTF-8 text file from the target repository (read-only).',
        'The path is relative to the repository root.',
        'Use it for conventions the raw style signals do not carry — e.g. a style guide under',
        'docs/. Dot-prefixed paths (.git, .env, .claude), directories and paths outside the',
        'repository are refused; an oversized file comes back truncated.',
      ].join(' '),
      inputSchema: readRepoFileInputSchema,
      execute: async (input: ReadRepoFileInput): Promise<string> =>
        readContainedFile(repoRoot, input.path),
    }),
  };
}

// The contained read behind the tool. Never throws: a refused path (outside the root, a
// dot-prefixed segment, a directory) comes back as a refusal STRING the model can read and act
// on, so a bad path costs one step instead of the whole distillation.
export async function readContainedFile(repoRoot: string, requestedPath: string): Promise<string> {
  try {
    const target = await resolveInside(repoRoot, requestedPath);
    const rel = relative(resolve(repoRoot), target);
    if (hasDotSegment(rel)) return refusal('the path contains a dot-prefixed segment');
    const info = await stat(target);
    if (info.isDirectory()) return refusal('the path is a directory, not a file');
    if (!info.isFile()) return refusal('the path is not a regular file');
    return await readCapped(target);
  } catch (err) {
    return refusal(refusalReason(err));
  }
}

// A dot-prefixed segment (.git, .env, .claude) is a secret or a tool directory: never readable.
// Checked against the path RELATIVE to the repo root — the root's own ancestors may legitimately
// contain a dot (a checkout under ~/.config, say).
function hasDotSegment(relPath: string): boolean {
  return relPath.split(/[\\/]+/).some((segment) => segment.startsWith('.'));
}

async function readCapped(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(STYLE_EXPLORATION_MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= STYLE_EXPLORATION_MAX_FILE_BYTES) {
      return decodeUtf8(buffer.subarray(0, bytesRead));
    }
    return `${decodeUtf8(buffer.subarray(0, STYLE_EXPLORATION_MAX_FILE_BYTES))}${TRUNCATION_MARKER}`;
  } finally {
    await handle.close();
  }
}

// A file cut at the byte cap can end mid-character: drop the dangling replacement character
// rather than handing the model a broken glyph.
function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/\uFFFD+$/u, '');
}

function refusal(reason: string): string {
  return `refused: ${reason}`;
}

function refusalReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('path escapes worktree via symlink')) {
    return 'the path resolves outside the repository root';
  }
  if (message.startsWith('path escapes worktree')) {
    return 'the path is outside the repository root';
  }
  if (errorCode(err) === 'ENOENT') return 'the file does not exist';
  return `the file could not be read: ${message}`;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// The `<env>` system-context block injected into a subagent's system prompt so the model
// picks the right paths/commands. Portable: node:os/fs/path + process only (Bun, Node >=20, Deno).

import { existsSync } from 'node:fs';
import { arch as osArch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type EnvInfo = {
  cwd: string;
  // Omitted leaves the git line out (unknown); false renders "No".
  isGitRepo?: boolean;
  date?: string;
  // The resolved model id for this subagent's tier (e.g. `anthropic/claude-sonnet-4.5`). aitm routes
  // each role to a different capability tier, possibly a different vendor, and self-identification
  // from training data is unreliable — so the harness states it. Omitted → the line is left out.
  modelId?: string;
  // The model's knowledge cutoff (e.g. `January 2026`), so recency claims can be calibrated. Free-form
  // and caller-supplied (the OpenRouter catalog doesn't expose it uniformly). Omitted → line left out.
  knowledgeCutoff?: string;
};

// Is `cwd` inside a git repository? Walks from the resolved cwd up to the filesystem root and returns
// true on the first `.git` entry of ANY type — a directory in a normal checkout, a plain file in a
// linked worktree (`git worktree add`). Sync fs, so composeSystemPrompt can stay synchronous.
export function detectGitRepo(cwd: string): boolean {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false; // reached the filesystem root
    dir = parent;
  }
}

function runtimeLabel(): string {
  const v = process.versions as Record<string, string | undefined>;
  if (v.bun) return `bun ${v.bun}`;
  if (v.deno) return `deno ${v.deno}`;
  return `node ${process.version}`;
}

export function envBlock(info: EnvInfo): string {
  const lines = [
    '<env>',
    `Working directory: ${info.cwd}`,
    ...(info.isGitRepo === undefined
      ? []
      : [`Is directory a git repo: ${info.isGitRepo ? 'Yes' : 'No'}`]),
    `Platform: ${process.platform}`,
    `OS version: ${release()}`,
    `Arch: ${osArch()}`,
    `Shell: ${process.env.SHELL ?? ''}`,
    `Runtime: ${runtimeLabel()}`,
    ...(info.modelId === undefined ? [] : [`Model: ${info.modelId}`]),
    ...(info.knowledgeCutoff === undefined ? [] : [`Knowledge cutoff: ${info.knowledgeCutoff}`]),
    `Today's date: ${info.date ?? new Date().toISOString().slice(0, 10)}`,
    '</env>',
  ];
  return lines.join('\n');
}

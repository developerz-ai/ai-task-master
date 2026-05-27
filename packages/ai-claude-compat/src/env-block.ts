// The `<env>` system-context block — the environment snapshot a Claude-Code-style agent gets
// before its first turn (cwd, git-repo, platform, OS, shell, runtime, date). Inject the result
// into a subagent's system prompt so the model picks the right paths and commands.
//
// Portable: only `node:os` + `process` (platform/arch/versions/env), which behave the same on
// Bun, Node >= 20, and Deno. No runtime-specific APIs.

import { arch as osArch, release } from 'node:os';

export type EnvInfo = {
  // Absolute path the agent's tools are scoped to (the worktree / repo root).
  cwd: string;
  // Whether `cwd` is a git working tree. Omit if unknown — the line is then left out.
  isGitRepo?: boolean;
  // Override the wall-clock date (ISO yyyy-mm-dd). Defaults to today. Handy for tests.
  date?: string;
};

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
    `Today's date: ${info.date ?? new Date().toISOString().slice(0, 10)}`,
    '</env>',
  ];
  return lines.join('\n');
}

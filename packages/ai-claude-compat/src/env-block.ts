// The `<env>` system-context block injected into a subagent's system prompt so the model
// picks the right paths/commands. Portable: node:os + process only (Bun, Node >=20, Deno).

import { arch as osArch, release } from 'node:os';

export type EnvInfo = {
  cwd: string;
  // Omitted leaves the git line out (unknown); false renders "No".
  isGitRepo?: boolean;
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

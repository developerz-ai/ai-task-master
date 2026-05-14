// docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md
// Dispatcher only. Each command does precondition checks → wires deps → kicks WorkLoop / writes config.

import type { ParsedArgs } from './args.ts';

export type CommandExit = { code: 0 | 1 | 2; message?: string };

export async function runStart(
  _args: Extract<ParsedArgs, { kind: 'start' }>,
): Promise<CommandExit> {
  throw new Error('not implemented');
}

export async function runMergePr(
  _args: Extract<ParsedArgs, { kind: 'merge-pr' }>,
): Promise<CommandExit> {
  throw new Error('not implemented');
}

export async function runConfig(
  _args: Extract<ParsedArgs, { kind: `config-${string}` }>,
): Promise<CommandExit> {
  throw new Error('not implemented');
}

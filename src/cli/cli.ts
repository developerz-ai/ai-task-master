#!/usr/bin/env node
// docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md
// Single entry. Parses argv, dispatches, exits with the right code.

import { parseArgs } from './args.ts';
import { runConfig, runMergePr, runStart } from './commands.ts';

export async function main(_argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseArgs(_argv);
  switch (parsed.kind) {
    case 'start':
      return (await runStart(parsed)).code;
    case 'merge-pr':
      return (await runMergePr(parsed)).code;
    case 'config-set':
    case 'config-unset':
    case 'config-get':
    case 'config-list':
      return (await runConfig(parsed)).code;
    case 'help':
      throw new Error('not implemented');
  }
}

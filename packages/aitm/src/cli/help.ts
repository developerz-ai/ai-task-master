// docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md, docs/commands/profile.md
// Single source of truth for the CLI's command/flag surface. HELP_TEXT is generated from the table
// below, so a flag can never be parsed-but-undocumented (or documented-but-unparsed): args.ts
// recognizes the same tokens and help.test.ts pins the two sets equal. The `--preset` value list is
// built from PRESET_NAMES, so it can't drift from the presets the parser actually accepts either.

import { PRESET_NAMES } from '../config/provider-presets.ts';

// A flag as it appears in a usage synopsis. `tokens` are the literal argv spellings the parser
// accepts — aliases share one entry (`['--force', '-f']`) and render joined by `|`. `value` is the
// placeholder for a value-taking flag; omitted for a boolean flag.
export type FlagSpec = {
  tokens: readonly [string, ...string[]];
  value?: string;
};

// One line under `Usage:`. `invocation` is the command plus its positionals (`aitm start "<goal>"`);
// `flags` render as bracketed options after it, wrapped onto aligned continuation lines. `note`
// renders verbatim after the invocation instead of flags (resume's "same flags as start" pointer).
export type CommandSpec = {
  invocation: string;
  flags?: readonly FlagSpec[];
  note?: string;
};

export const CLI_COMMANDS: readonly CommandSpec[] = [
  {
    invocation: 'aitm start "<goal>"',
    flags: [
      { tokens: ['--criteria'], value: '"..."' },
      { tokens: ['--max-prs'], value: 'N' },
      { tokens: ['--max-sessions'], value: 'N' },
      { tokens: ['--max-fix-attempts'], value: 'N' },
      { tokens: ['--concurrency'], value: 'N' },
      { tokens: ['--no-automerge'] },
      { tokens: ['--admin'] },
      { tokens: ['--allow-dirty'] },
      { tokens: ['--pr-per-task'] },
      { tokens: ['--style'], value: '<path>' },
      { tokens: ['--model'], value: '<id>' },
      { tokens: ['--branch'], value: '<name>' },
    ],
  },
  {
    invocation: 'aitm resume',
    note: '[same flags as start; the goal comes from .ai-task-master/]',
  },
  {
    invocation: 'aitm merge-pr',
    flags: [
      { tokens: ['--pr'], value: 'N' },
      { tokens: ['--max-iterations'], value: 'N' },
      { tokens: ['--no-resume'] },
      { tokens: ['--admin'] },
    ],
  },
  { invocation: 'aitm config set <key> <value>', flags: [{ tokens: ['--project'] }] },
  { invocation: 'aitm config unset <key>', flags: [{ tokens: ['--project'] }] },
  { invocation: 'aitm config get <key>', flags: [{ tokens: ['--project'] }] },
  {
    invocation: 'aitm config list',
    flags: [{ tokens: ['--project'] }, { tokens: ['--effective'] }],
  },
  { invocation: 'aitm profile list' },
  { invocation: 'aitm profile use <name>' },
  {
    invocation: 'aitm profile add <name>',
    flags: [
      { tokens: ['--preset'], value: PRESET_NAMES.join('|') },
      { tokens: ['--base-url'], value: '<url>' },
      { tokens: ['--api-key'], value: '<key>' },
      { tokens: ['--api-key-stdin'] },
    ],
  },
  { invocation: 'aitm profile set <name> <key> <value>' },
  { invocation: 'aitm profile get <name> <key>' },
  { invocation: 'aitm profile remove <name>' },
  { invocation: 'aitm profile rename <from> <to>' },
  { invocation: 'aitm profile show [<name>]' },
  {
    invocation: 'aitm mcp-login <server-url>',
    flags: [
      { tokens: ['--callback-url'], value: '<url>' },
      { tokens: ['--timeout'], value: '<ms>' },
    ],
  },
  { invocation: 'aitm clean', flags: [{ tokens: ['--force', '-f'] }] },
  { invocation: 'aitm update', flags: [{ tokens: ['--check'] }] },
  { invocation: 'aitm help | --help | -h' },
  { invocation: 'aitm version | --version | -v' },
];

// Keep synopsis lines readable; continuation lines align under the first bracketed flag.
const WRAP_WIDTH = 78;

function renderFlag(flag: FlagSpec): string {
  const head = flag.tokens.join('|');
  return flag.value === undefined ? `[${head}]` : `[${head} ${flag.value}]`;
}

function renderCommand(cmd: CommandSpec): string {
  const base = `  ${cmd.invocation}`;
  const pieces: string[] = [];
  if (cmd.note !== undefined) pieces.push(cmd.note);
  if (cmd.flags !== undefined) for (const flag of cmd.flags) pieces.push(renderFlag(flag));
  if (pieces.length === 0) return base;

  const indent = ' '.repeat(base.length + 1);
  let out = base;
  let lineLen = base.length;
  let atLineStart = true;
  for (const piece of pieces) {
    if (!atLineStart && lineLen + 1 + piece.length > WRAP_WIDTH) {
      out += `\n${indent}${piece}`;
      lineLen = indent.length + piece.length;
    } else {
      out += ` ${piece}`;
      lineLen += 1 + piece.length;
    }
    atLineStart = false;
  }
  return out;
}

export function renderHelp(): string {
  const usage = CLI_COMMANDS.map(renderCommand).join('\n');
  return `aitm — autonomous task orchestrator

Usage:
${usage}

Exit codes:
  0  success
  1  precondition failure or run blocked
  2  cancelled, or invalid/malformed command-line usage

Docs: docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md, docs/commands/profile.md`;
}

export const HELP_TEXT = renderHelp();

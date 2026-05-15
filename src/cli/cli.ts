#!/usr/bin/env node
// docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md
// Single entry. Parses argv, dispatches, exits with the right code.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './args.ts';
import type { MergePrCtx, StartCtx } from './commands.ts';
import { runConfig, runMergePr, runStart } from './commands.ts';

export type MainCtx = {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  authStatus?: StartCtx['authStatus'];
  runLoop?: StartCtx['runLoop'];
  runMergeFlow?: MergePrCtx['runMergeFlow'];
};

export async function main(argv: ReadonlyArray<string>, ctx: MainCtx = {}): Promise<number> {
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = ctx.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case 'start':
      return emit(await runStart(parsed, buildStartCtx(ctx)), stderr);
    case 'merge-pr':
      return emit(await runMergePr(parsed, buildMergePrCtx(ctx)), stderr);
    case 'config-set':
    case 'config-unset':
    case 'config-get':
    case 'config-list':
      return emit(await runConfig(parsed, buildConfigCtx(ctx, stdout)), stderr);
    case 'help':
      stdout(`${HELP_TEXT}\n`);
      return 0;
  }
}

function buildStartCtx(ctx: MainCtx): StartCtx {
  const out: StartCtx = {};
  if (ctx.cwd !== undefined) out.cwd = ctx.cwd;
  if (ctx.homeDir !== undefined) out.homeDir = ctx.homeDir;
  if (ctx.env !== undefined) out.env = ctx.env;
  if (ctx.authStatus !== undefined) out.authStatus = ctx.authStatus;
  if (ctx.runLoop !== undefined) out.runLoop = ctx.runLoop;
  return out;
}

function buildMergePrCtx(ctx: MainCtx): MergePrCtx {
  const out: MergePrCtx = {};
  if (ctx.cwd !== undefined) out.cwd = ctx.cwd;
  if (ctx.homeDir !== undefined) out.homeDir = ctx.homeDir;
  if (ctx.env !== undefined) out.env = ctx.env;
  if (ctx.authStatus !== undefined) out.authStatus = ctx.authStatus;
  if (ctx.runMergeFlow !== undefined) out.runMergeFlow = ctx.runMergeFlow;
  return out;
}

function buildConfigCtx(
  ctx: MainCtx,
  stdout: (chunk: string) => void,
): { cwd?: string; homeDir?: string; stdout: (chunk: string) => void } {
  const out: { cwd?: string; homeDir?: string; stdout: (chunk: string) => void } = { stdout };
  if (ctx.cwd !== undefined) out.cwd = ctx.cwd;
  if (ctx.homeDir !== undefined) out.homeDir = ctx.homeDir;
  return out;
}

function emit(
  exit: { code: 0 | 1 | 2; message?: string },
  stderr: (chunk: string) => void,
): number {
  if (exit.message !== undefined && exit.message !== '') stderr(`${exit.message}\n`);
  return exit.code;
}

const HELP_TEXT = `aitm — autonomous task orchestrator

Usage:
  aitm start "<goal>" [--criteria "..."] [--max-prs N] [--max-sessions N]
                      [--no-automerge] [--style <path>] [--model <id>]
                      [--concurrency N]
  aitm merge-pr [--pr N] [--no-resume]
  aitm config set <key> <value> [--project]
  aitm config unset <key>       [--project]
  aitm config get <key>         [--project]
  aitm config list              [--project]
  aitm help | --help | -h

Exit codes:
  0  success
  1  precondition failure or run blocked
  2  cancelled

Docs: docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md`;

// Entry-point: when invoked as a script (via the `aitm` bin), parse process.argv
// and propagate the exit code. When imported (e.g. from tests), this is skipped.
if (isEntrypoint(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

// Exported for unit-test coverage of the symlink case (global installs put a symlink at
// e.g. ~/.bun/bin/aitm pointing at dist/cli/cli.js — argv[1] and import.meta.url differ
// until argv[1] is resolved via realpath).
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    const real = realpathSync(argv1);
    return metaUrl === pathToFileURL(real).href;
  } catch {
    return false;
  }
}

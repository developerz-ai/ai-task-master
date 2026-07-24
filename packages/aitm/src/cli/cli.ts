#!/usr/bin/env node
// docs/commands/start.md, docs/commands/merge-pr.md, docs/commands/config.md
// Single entry. Parses argv, dispatches, exits with the right code.

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { type ErrorReporter, initErrorReporter } from '../observability/error-reporter.ts';
import { parseArgs } from './args.ts';
import type {
  CleanCtx,
  ConfigCtx,
  McpLoginCtx,
  MergePrCtx,
  ProfileCtx,
  StartCtx,
} from './commands.ts';
import {
  runClean,
  runConfig,
  runMcpLogin,
  runMergePr,
  runProfile,
  runResume,
  runStart,
} from './commands.ts';
import { HELP_TEXT } from './help.ts';
import { runUpdate } from './update.ts';

export type MainCtx = {
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  authStatus?: StartCtx['authStatus'];
  runPlanner?: StartCtx['runPlanner'];
  runLoop?: StartCtx['runLoop'];
  runMergeFlow?: MergePrCtx['runMergeFlow'];
  // Abort handle threaded into both flows: the merge-pr take-over loop → `{ kind: 'cancelled' }`
  // (exit 2), and the start loop → eager MCP close so a force-exit can't orphan stdio children.
  // The entrypoint wires this to SIGINT/SIGTERM; tests drive it directly.
  signal?: AbortSignal;
};

export async function main(argv: ReadonlyArray<string>, ctx: MainCtx = {}): Promise<number> {
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = ctx.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case 'start':
      return emit(await runStart(parsed, buildStartCtx(ctx)), stdout, stderr);
    case 'resume':
      return emit(await runResume(parsed, buildStartCtx(ctx)), stdout, stderr);
    case 'merge-pr':
      return emit(await runMergePr(parsed, buildMergePrCtx(ctx)), stdout, stderr);
    case 'config-set':
    case 'config-unset':
    case 'config-get':
    case 'config-list':
      return emit(await runConfig(parsed, buildConfigCtx(ctx, stdout, stderr)), stdout, stderr);
    case 'profile-list':
    case 'profile-use':
    case 'profile-add':
    case 'profile-set':
    case 'profile-get':
    case 'profile-remove':
    case 'profile-rename':
    case 'profile-show':
      return emit(await runProfile(parsed, buildProfileCtx(ctx, stdout)), stdout, stderr);
    case 'clean':
      return emit(await runClean(parsed, buildCleanCtx(ctx, stdout)), stdout, stderr);
    case 'update':
      return emit(
        await runUpdate(parsed, { stdout, currentVersion: await readVersion() }),
        stdout,
        stderr,
      );
    case 'mcp-login':
      return emit(await runMcpLogin(parsed, buildMcpLoginCtx(ctx, stdout, stderr)), stdout, stderr);
    case 'help':
      stdout(`${HELP_TEXT}\n`);
      return 0;
    case 'version':
      stdout(`${await readVersion()}\n`);
      return 0;
    case 'usage-error':
      stderr(`${HELP_TEXT}\n`);
      return 2;
  }
}

function buildStartCtx(ctx: MainCtx): StartCtx {
  const out: StartCtx = {};
  if (ctx.cwd !== undefined) out.cwd = ctx.cwd;
  if (ctx.homeDir !== undefined) out.homeDir = ctx.homeDir;
  if (ctx.env !== undefined) out.env = ctx.env;
  if (ctx.authStatus !== undefined) out.authStatus = ctx.authStatus;
  if (ctx.runPlanner !== undefined) out.runPlanner = ctx.runPlanner;
  if (ctx.runLoop !== undefined) out.runLoop = ctx.runLoop;
  if (ctx.signal !== undefined) out.signal = ctx.signal;
  return out;
}

function buildMergePrCtx(ctx: MainCtx): MergePrCtx {
  const out: MergePrCtx = {};
  if (ctx.cwd !== undefined) out.cwd = ctx.cwd;
  if (ctx.homeDir !== undefined) out.homeDir = ctx.homeDir;
  if (ctx.env !== undefined) out.env = ctx.env;
  if (ctx.authStatus !== undefined) out.authStatus = ctx.authStatus;
  if (ctx.runMergeFlow !== undefined) out.runMergeFlow = ctx.runMergeFlow;
  if (ctx.signal !== undefined) out.signal = ctx.signal;
  return out;
}

function buildConfigCtx(
  ctx: MainCtx,
  stdout: (chunk: string) => void,
  stderr: (chunk: string) => void,
): ConfigCtx {
  const out: ConfigCtx = { stdout, stderr };
  if (ctx.cwd !== undefined) out.cwd = ctx.cwd;
  if (ctx.homeDir !== undefined) out.homeDir = ctx.homeDir;
  if (ctx.env !== undefined) out.env = ctx.env;
  return out;
}

function buildProfileCtx(ctx: MainCtx, stdout: (chunk: string) => void): ProfileCtx {
  const out: ProfileCtx = { stdout };
  if (ctx.homeDir !== undefined) out.homeDir = ctx.homeDir;
  return out;
}

function buildCleanCtx(ctx: MainCtx, stdout: (chunk: string) => void): CleanCtx {
  const out: CleanCtx = { stdout };
  if (ctx.cwd !== undefined) out.cwd = ctx.cwd;
  return out;
}

function buildMcpLoginCtx(
  ctx: MainCtx,
  stdout: (chunk: string) => void,
  stderr: (chunk: string) => void,
): McpLoginCtx {
  return { stdout, stderr };
}

function emit(
  exit: { code: 0 | 1 | 2; message?: string },
  stdout: (chunk: string) => void,
  stderr: (chunk: string) => void,
): number {
  if (exit.message !== undefined && exit.message !== '') {
    const dest = exit.code === 0 ? stdout : stderr;
    dest(`${exit.message}\n`);
  }
  return exit.code;
}

// The installed version, read from the package manifest at run time rather than baked in by the
// build, so `aitm --version` can never disagree with what npm/bun actually installed. Both `src/`
// and the built `dist/` sit two levels under the package root, so one relative URL serves both.
// Unreadable manifest → 'unknown' rather than a crash: a version probe must never fail.
async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === 'string') return version;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

// Minimal process surface the shutdown wiring touches. Injectable so the abort, force-exit and
// exit-code branches are unit-testable without attaching handlers to — or calling `exit`/`exitCode`
// on — the real test-runner process. `exit` is typed `void` (not `never`): the handlers `return`
// after it rather than leaning on it to terminate, so a test double can record a call and carry on.
export type SignalProcess = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off?(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
  stderr: { write(chunk: string): boolean };
};

// The entrypoint also sets `exitCode`; widened to Node's own union so the real `process` satisfies it.
export type EntrypointProcess = SignalProcess & {
  exitCode?: number | string | null | undefined;
};

const CANCEL_SIGNALS: ReadonlyArray<{ name: NodeJS.Signals; signo: number }> = [
  { name: 'SIGINT', signo: 2 },
  { name: 'SIGTERM', signo: 15 },
];

// A force-quit still tries to flush the crash report, but only for this long: the user hit Ctrl-C a
// second time because something is wedged, so the reporter must never trap them. Matches the
// reporter's own internal flush budget — a healthy drain finishes well inside it.
const FORCE_EXIT_FLUSH_MS = 2000;

// Second-signal force-quit: flush the reporter (bounded), then exit with the conventional 128+signo
// code no matter what. Whichever of the flush and the deadline settles first triggers the single
// exit; the timer is unref'd so it can never itself hold the process open past the flush.
export function forceExit(
  reporter: Pick<ErrorReporter, 'flush'>,
  code: number,
  proc: Pick<SignalProcess, 'exit'> = process,
  flushBudgetMs: number = FORCE_EXIT_FLUSH_MS,
): void {
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    proc.exit(code);
  };
  const timer = setTimeout(exit, flushBudgetMs);
  (timer as { unref?: () => void }).unref?.();
  void reporter.flush().finally(() => {
    clearTimeout(timer);
    exit();
  });
}

// First SIGINT/SIGTERM aborts the run so an in-flight flow unwinds to `{ kind: 'cancelled' }`
// (exit 2, wired through the merge-pr take-over loop); a second one force-exits — via `onForceExit`
// when given, so the crash report still flushes, else a bare `exit`. Returns a remover the entrypoint
// calls once `main` resolves, so a late Ctrl-C during the final flush can't re-abort or print a
// meaningless "Cancelling".
export function installSignalHandlers(
  controller: AbortController,
  opts: { proc?: SignalProcess; onForceExit?: (code: number) => void } = {},
): () => void {
  const proc = opts.proc ?? process;
  const installed: Array<{ name: NodeJS.Signals; listener: () => void }> = [];
  for (const { name, signo } of CANCEL_SIGNALS) {
    const listener = (): void => {
      if (controller.signal.aborted) {
        if (opts.onForceExit) opts.onForceExit(128 + signo);
        else proc.exit(128 + signo);
        return;
      }
      proc.stderr.write('\nCancelling — interrupt again to force-quit.\n');
      controller.abort();
    };
    proc.on(name, listener);
    installed.push({ name, listener });
  }
  return () => {
    for (const { name, listener } of installed) proc.off?.(name, listener);
  };
}

// One shutdown path for every exit. `main`'s code becomes `process.exitCode` — not a hard
// `process.exit` — so buffered stdout/stderr and any pending state/log writes drain before the
// process ends instead of being truncated mid-pipe; the `finally` removes the signal handlers and
// flushes the reporter on the normal, error AND first-signal (graceful `cancelled`) paths alike. The
// second-signal force-quit is the only hard exit, and it still flushes (bounded) via `forceExit`.
export async function runEntrypoint(
  reporter: ErrorReporter,
  argv: ReadonlyArray<string>,
  proc: EntrypointProcess = process,
  run: (argv: ReadonlyArray<string>, ctx: MainCtx) => Promise<number> = main,
): Promise<void> {
  const controller = new AbortController();
  const removeSignalHandlers = installSignalHandlers(controller, {
    proc,
    onForceExit: (code) => forceExit(reporter, code, proc),
  });
  try {
    proc.exitCode = await run(argv, { signal: controller.signal });
  } catch (err: unknown) {
    reporter.captureException(err);
    proc.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    proc.exitCode = 1;
  } finally {
    removeSignalHandlers();
    await reporter.flush();
  }
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

// Entry-point: when invoked as a script (via the `aitm` bin), drive the unified shutdown over
// process.argv. When imported (e.g. from tests), this is skipped. A crash is reported to GlitchTip
// when a DSN is configured (no-op otherwise) and flushed on the way out.
if (isEntrypoint(import.meta.url, process.argv[1])) {
  void (async () => {
    const reporter = await initErrorReporter();
    await runEntrypoint(reporter, process.argv.slice(2));
  })();
}

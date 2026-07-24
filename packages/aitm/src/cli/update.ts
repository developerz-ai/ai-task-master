// docs/commands/update.md. Mirror of claudetm's `update`: manual self-update only — the command
// reinstalls the published npm package globally (bun preferred, npm fallback) when explicitly
// run; nothing ever updates automatically. `--check` reports whether a newer version exists and
// exits without installing.

import process from 'node:process';
import { defaultRunCmd, type RunCmd } from '../github/github-client.ts';
import type { UpdateArgs } from './args.ts';
import type { CommandExit } from './commands.ts';

export const AITM_PACKAGE = '@developerz.ai/aitm';
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(AITM_PACKAGE)}/latest`;

export type UpdateCtx = {
  stdout?: (chunk: string) => void;
  // Injected by cli.ts from package.json; undefined when unknown.
  currentVersion?: string;
  fetchFn?: typeof fetch;
  runCmd?: RunCmd;
};

// Registry lookup degrades gracefully: any network/shape failure returns undefined and the
// install still proceeds — npm/bun resolve `@latest` themselves.
export async function fetchLatestVersion(fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const res = await fetchFn(REGISTRY_LATEST_URL);
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'version' in body) {
      const version = (body as { version: unknown }).version;
      if (typeof version === 'string') return version;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// bun first (the documented install path), npm as fallback. A missing binary makes defaultRunCmd
// throw (ENOENT → typed domain error), so probe with --version and treat any throw as absent.
export async function pickInstaller(
  runCmd: RunCmd,
): Promise<{ file: string; args: string[] } | undefined> {
  for (const candidate of [
    { file: 'bun', args: ['install', '-g', `${AITM_PACKAGE}@latest`] },
    { file: 'npm', args: ['install', '-g', `${AITM_PACKAGE}@latest`] },
  ]) {
    try {
      const probe = await runCmd(candidate.file, ['--version']);
      if (probe.exitCode === 0) return candidate;
    } catch {
      // not installed — try the next candidate
    }
  }
  return undefined;
}

export async function runUpdate(args: UpdateArgs, ctx: UpdateCtx = {}): Promise<CommandExit> {
  const stdout = ctx.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const runCmd = ctx.runCmd ?? defaultRunCmd;
  const fetchFn = ctx.fetchFn ?? fetch;
  const current = ctx.currentVersion;

  if (current !== undefined) stdout(`Current version: ${current}\n`);
  const latest = await fetchLatestVersion(fetchFn);
  if (latest === undefined) {
    stdout('Could not reach the npm registry to check the latest version.\n');
  } else {
    stdout(`Latest version:  ${latest}\n`);
    if (latest === current) {
      stdout('Already up to date.\n');
      return { code: 0 };
    }
  }

  if (args.check) {
    if (latest !== undefined) {
      stdout(`Update available: ${current ?? 'unknown'} -> ${latest}\n`);
      stdout('Run `aitm update` to install it.\n');
    }
    return { code: 0 };
  }

  const installer = await pickInstaller(runCmd);
  if (installer === undefined) {
    return {
      code: 1,
      message: `Neither bun nor npm found on PATH. Install one and run: bun install -g ${AITM_PACKAGE}@latest`,
    };
  }

  stdout(`Running: ${installer.file} ${installer.args.join(' ')}\n`);
  try {
    const result = await runCmd(installer.file, installer.args, { timeout: 10 * 60_000 });
    if (result.exitCode !== 0) {
      const reason = result.stderr.trim();
      return {
        code: 1,
        message: `update failed (exit ${result.exitCode})${reason === '' ? '' : `: ${reason}`}`,
      };
    }
  } catch (err) {
    return { code: 1, message: err instanceof Error ? err.message : String(err) };
  }
  stdout('Update complete. Run `aitm version` to confirm.\n');
  return { code: 0 };
}

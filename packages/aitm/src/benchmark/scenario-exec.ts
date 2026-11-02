// A bounded executor for MODEL-PRODUCED tests inside a sandbox checkout (#308). The benchmark runner
// builds one per run with makeSandboxTestRunner(checkoutDir) and injects it into a scenario's verify()
// as ScenarioVerify.runTest; the scenario decides when (and whether) to call it.
//
// Deliberately plain node:child_process spawn — no shell, no service dependency. The harness runtime
// is the only thing invoked: bun (`bun test`) natively, or node with the tsx loader resolved from
// THIS checkout (the sandbox is bare — no package.json, no node_modules — so a bare `--import tsx`
// there would not resolve). The test file is passed as an ABSOLUTE path, so the executor does not
// depend on the caller's cwd. Output is captured with a per-stream cap (keeping the tail: node:test
// prints its failure summary at the END of the stream), a hung run has its WHOLE process tree
// killed at the budget — `node --test` executes the produced file in a child of the spawned
// wrapper, so killing the wrapper alone would strand that child forever — and every failure mode —
// tooling unresolvable, spawn error, timeout — resolves as a ScenarioExecResult, never a rejection,
// so a scenario verdict is always reachable. Portable Node APIs only (bun + node).

import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ScenarioExecResult } from './scenarios.ts';

// ~1MiB per stream: a runaway produced test cannot balloon this process's memory, while a real
// failure's summary (printed at the end of the output) still survives for the verdict detail.
const STREAM_CAP_CHARS = 1024 * 1024;

// How long the budget kill may take before the executor resolves anyway. A kill that never lands
// must not turn the execution budget into an unbounded wait.
const KILL_GRACE_MS = 5_000;

// POSIX only: a detached spawn makes the runner a process-group leader, which is what lets the
// budget kill reach the whole tree. On Windows `detached` changes console semantics instead and
// there is no negative-pid kill — the runner stays attached and the tree is killed by taskkill.
const IS_WINDOWS = process.platform === 'win32';

// The harness command that runs one produced test. Resolved lazily (on the first execution, not at
// factory time) and memoized: an unresolvable tsx surfaces as an error RESULT on every call, never a
// thrown error from a factory the runner might call before it even needs the executor.
type Tooling =
  | { command: (absTestPath: string) => { file: string; args: string[] } }
  | { unavailable: string };

function resolveTooling(): Tooling {
  if (process.versions.bun) {
    return { command: (abs) => ({ file: process.execPath, args: ['test', abs] }) };
  }
  try {
    const tsxUrl = import.meta.resolve('tsx');
    return {
      command: (abs) => ({ file: process.execPath, args: ['--import', tsxUrl, '--test', abs] }),
    };
  } catch (err) {
    return {
      unavailable: `harness test tooling (tsx) unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// Terminate the whole process TREE rooted at `pid`, not just that process. `node --test` executes
// the produced file in a CHILD of the spawned wrapper, so a wrapper-only kill orphans a hung test:
// it is reparented, stays hung forever, and keeps the run's stdout pipe open.
//
// POSIX: the detached wrapper leads a process group, so SIGKILL to the NEGATIVE pid reaches the
// produced test too. Windows has neither process groups nor a negative-pid kill — SIGKILL to the
// wrapper alone strands `node --test`'s worker — so the tree is taken down with `taskkill /T /F`,
// which walks the children itself. The wrapper-only kill is the last resort for a missing taskkill.
export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ESRCH — the tree already exited; nothing left to signal.
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => {
      // No taskkill on this machine — kill the wrapper at least, so the run still ends.
      killWrapper(pid);
      resolve();
    });
    killer.once('close', (code) => {
      if (code !== 0) killWrapper(pid);
      resolve();
    });
  });
}

// Windows fallback: terminate the wrapper process itself. Its worker can survive this — nothing
// else is left to try — but the run still ends.
function killWrapper(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

export function makeSandboxTestRunner(
  checkoutDir: string,
): (testPath: string, timeoutMs: number) => Promise<ScenarioExecResult> {
  let tooling: Tooling | null = null;
  return (testPath, timeoutMs) => {
    tooling ??= resolveTooling();
    const resolved = tooling;
    if ('unavailable' in resolved) {
      return Promise.resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: resolved.unavailable,
      });
    }
    return new Promise((resolve) => {
      const abs = join(checkoutDir, testPath);
      const { file, args } = resolved.command(abs);
      // Keep the TAIL of each stream: a cap that keeps the head would drop exactly the part of a
      // failure (the summary node:test prints last) that the verdict detail needs.
      const capped = (soFar: string, chunk: Buffer): string =>
        (soFar + chunk.toString('utf8')).slice(-STREAM_CAP_CHARS);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let child: ChildProcess | undefined;
      let killed: Promise<void> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        // Signal the TREE, not the wrapper: `node --test` runs the produced file in a child
        // process, so a wrapper-only kill orphans a hung test and it survives the budget forever.
        const pid = child?.pid;
        killed = pid === undefined ? Promise.resolve() : killProcessTree(pid, process.platform);
        // The kill is awaited before the result is reported, so "timed out" never means "the tree
        // is still running" — but a kill that never lands must not turn the budget into an
        // unbounded wait either.
        graceTimer = setTimeout(() => {
          finish({ exitCode: null, stdout, stderr, timedOut: true });
        }, KILL_GRACE_MS);
      }, timeoutMs);
      const finish = (result: ScenarioExecResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        resolve(result);
      };
      try {
        // Strip node:test's child marker: when THIS process itself runs under `node --test`, the env
        // carries NODE_TEST_CONTEXT, and a runner spawned with it inherits the delegation mode —
        // "node:test run() is being called recursively within a test file. skipping running files"
        // — exiting 0 with no output and never executing anything. The produced test must run
        // standalone, never as a delegated child of whoever called verify().
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        child = spawn(file, args, {
          cwd: checkoutDir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !IS_WINDOWS,
        });
      } catch (err) {
        finish({
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = capped(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = capped(stderr, chunk);
      });
      child.once('error', (err) => {
        finish({ exitCode: null, stdout, stderr, timedOut, error: err.message });
      });
      child.once('close', (code) => {
        const result = timedOut
          ? { exitCode: null, stdout, stderr, timedOut: true }
          : { exitCode: code, stdout, stderr, timedOut: false };
        if (!killed) {
          finish(result);
          return;
        }
        void killed.then(
          () => finish(result),
          () => finish(result),
        );
      });
    });
  };
}

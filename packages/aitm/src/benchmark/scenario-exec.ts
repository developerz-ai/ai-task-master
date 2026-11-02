// A bounded executor for MODEL-PRODUCED tests inside a sandbox checkout (#308). The benchmark runner
// builds one per run with makeSandboxTestRunner(checkoutDir) and injects it into a scenario's verify()
// as ScenarioVerify.runTest; the scenario decides when (and whether) to call it.
//
// Deliberately plain node:child_process spawn — no shell, no service dependency. The harness runtime
// is the only thing invoked: bun (`bun test`) natively, or node with the tsx loader resolved from
// THIS checkout (the sandbox is bare — no package.json, no node_modules — so a bare `--import tsx`
// there would not resolve). The test file is passed as an ABSOLUTE path, so the executor does not
// depend on the caller's cwd. Output is captured with a per-stream cap (keeping the tail: node:test
// prints its failure summary at the END of the stream), a hung run has its WHOLE process group
// SIGKILLed at the budget — `node --test` executes the produced file in a child of the spawned
// wrapper, so killing the wrapper alone would strand that child forever — and
// every failure mode — tooling unresolvable, spawn error, timeout — resolves as a ScenarioExecResult,
// never a rejection, so a scenario verdict is always reachable. Portable Node APIs only (bun + node).

import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ScenarioExecResult } from './scenarios.ts';

// ~1MiB per stream: a runaway produced test cannot balloon this process's memory, while a real
// failure's summary (printed at the end of the output) still survives for the verdict detail.
const STREAM_CAP_CHARS = 1024 * 1024;

// POSIX only: a detached spawn makes the runner a process-group leader, which is what lets the
// budget kill reach the whole tree. On Windows `detached` changes console semantics instead and
// there is no negative-pid kill — the runner stays attached and only the wrapper is signalled.
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
      // Signal the TREE, not the wrapper: `node --test` runs the produced file in a child process,
      // so a wrapper-only SIGKILL orphans a hung test and it survives the budget forever. The
      // detached spawn (POSIX) makes the wrapper a group leader, so a negative-pid kill reaches the
      // produced test too.
      const killTree = (): void => {
        const pid = child?.pid;
        if (pid === undefined) return;
        try {
          process.kill(IS_WINDOWS ? pid : -pid, 'SIGKILL');
        } catch {
          // ESRCH — the tree already exited; nothing left to signal.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
      const finish = (result: ScenarioExecResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
        finish(
          timedOut
            ? { exitCode: null, stdout, stderr, timedOut: true }
            : { exitCode: code, stdout, stderr, timedOut: false },
        );
      });
    });
  };
}

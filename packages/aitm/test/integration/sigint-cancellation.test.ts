// Integration: a SIGINT mid-`aitm start` must (a) reap the MCP server it spawned — a REAL child
// process, not an in-memory stub, so a leaked handle would show up as an actual leftover PID — and
// (b) surface `{ kind: 'cancelled' }` (exit code 2) instead of silently completing or blocking.
// docs/plans/2026/07/18/101-parallel-agent-bug-hunt/02-signal-cancellation-cleanup.md.
//
// Fidelity boundary (matches every other file in this suite, e.g. start-flow.test.ts): the LLM
// boundary is stubbed (style digest, Planner, Worker — no real model call, no real git checkout).
// Everything else is real: McpClientManager spawns test/integration/fixtures/stub-mcp-server.mjs as
// a genuine OS process over real stdio, and `runStart` (the real CLI dispatch used by `aitm start`,
// same as start-flow.test.ts) drives the real runLoopAdapter → WorkLoop stack, including the
// abort-listener/MCP-close wiring (run-loop-adapter.ts) and the cancellation check (work-loop.ts).
//
// A real SIGINT is simulated by aborting the same AbortController the CLI's SIGINT handler would
// abort (installSignalHandlers' OS-level wiring — registering the handler, force-exit on a second
// signal — is unit-tested directly in cli.test.ts; this test proves what happens once abort() is
// called, exactly like `aitm start`'s production entrypoint at cli.ts does on the real SIGINT).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runStart } from '../../src/cli/commands.ts';
import { runLoopAdapter } from '../../src/loop/run-loop-adapter.ts';
import type {
  CheckoutHome,
  WorkLoopGithub,
  WorkLoopOrchestrator,
} from '../../src/loop/work-loop.ts';
import { McpClientManager } from '../../src/mcp/mcp-client.ts';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_MCP_SERVER = join(HERE, 'fixtures', 'stub-mcp-server.mjs');

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await delay(20);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidFile: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFile, 'utf8');
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

test('aitm start: SIGINT mid-run reaps the MCP child and surfaces cancelled (exit 2), no orphan process', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const scratch = await mkdtemp(join(tmpdir(), 'aitm-sigint-'));
  const pidFile = join(scratch, 'mcp-server.pid');
  const workerStarted = join(scratch, 'worker-started');

  const mcp = new McpClientManager({
    servers: {
      stub: { command: 'node', args: [STUB_MCP_SERVER], env: { STUB_MCP_PID_FILE: pidFile } },
    },
  });
  await mcp.connectAll();

  const controller = new AbortController();

  const home: CheckoutHome = {
    acquire: async (groupId, branch) => ({ groupId, branch, path: repo.path }),
    release: async () => {},
  };
  const github: WorkLoopGithub = {
    defaultBranch: async () => 'main',
    waitForChecks: async () => ({ state: 'success', failedChecks: [] }),
    listUnresolvedThreads: async () => [],
    mergePr: async () => {},
  };

  try {
    const resultPromise = runStart(
      { kind: 'start', goal: 'add hello' },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'sk-or-test-key' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        resolveStyle: async () => '# CLAUDE.md\n',
        signal: controller.signal,
        runLoop: (input) =>
          runLoopAdapter(input, {
            makeMcp: () => mcp,
            makeCheckout: () => home,
            makeGithub: () => github,
            planGroups: async () => ({
              kind: 'ok',
              groups: [
                {
                  id: 'g',
                  title: 'g',
                  tasks: [{ id: 't1', text: 'do it', complexity: 'normal', done: false }],
                  dependsOn: [],
                  branch: 'aitm/g',
                  pr: null,
                  status: 'pending',
                },
              ],
            }),
            makeOrchestrator: (ctx): WorkLoopOrchestrator => ({
              // Blocks "mid-run" (like an in-flight LLM call) until the signal aborts, mirroring a
              // real Ctrl-C landing while the Worker is mid-flight.
              runWorker: async () => {
                await writeFile(workerStarted, 'ready');
                return await new Promise((_resolve, reject) => {
                  ctx.input.signal?.addEventListener(
                    'abort',
                    () => reject(new Error('aborted by signal')),
                    { once: true },
                  );
                });
              },
              finalizeCommit: async () => {
                throw new Error('finalizeCommit must not run — the run cancels before commit');
              },
              openPr: async () => {
                throw new Error('openPr must not run — the run cancels before PR open');
              },
              runCiFix: async () => {
                throw new Error('runCiFix must not run');
              },
              addressReviews: async () => {
                throw new Error('addressReviews must not run');
              },
            }),
          }),
      },
    );

    // The MCP child must actually be running before we cancel — otherwise "no orphan processes"
    // would be a vacuous assertion.
    await waitFor(async () => (await readPid(pidFile)) !== null);
    const pid = await readPid(pidFile);
    assert.ok(pid !== null);
    assert.equal(isAlive(pid), true, 'the stub MCP server must be alive before cancellation');

    // Wait until the run is genuinely mid-flight (the stubbed Worker has started) before cancelling
    // — a Ctrl-C partway through a run, not one that races the run's own startup.
    await waitFor(async () => {
      try {
        await readFile(workerStarted, 'utf8');
        return true;
      } catch {
        return false;
      }
    });

    controller.abort();

    const result = await resultPromise;

    assert.equal(
      result.code,
      2,
      `expected cancelled exit code 2, got ${result.code}: ${result.message ?? ''}`,
    );
    assert.match(result.message ?? '', /Cancelled/);

    // No orphan processes: the MCP child must be reaped once the run cancels.
    await waitFor(async () => !isAlive(pid));
    assert.equal(isAlive(pid), false, 'the MCP child process must not survive the cancelled run');
  } finally {
    await mcp.close().catch(() => {});
    await repo.cleanup();
    await rm(scratch, { recursive: true, force: true });
  }
});

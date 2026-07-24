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
import { MockLanguageModelV3 } from 'ai/test';
import { runStart } from '../../src/cli/commands.ts';
import {
  CHECKS_START_WAIT_MS,
  GitHubClient,
  isInstantSleepEnabled,
  type RunCmd,
} from '../../src/github/github-client.ts';
import type { ReviewThread } from '../../src/github/schema.ts';
import { runLoopAdapter } from '../../src/loop/run-loop-adapter.ts';
import type {
  CheckoutHome,
  WorkLoopGithub,
  WorkLoopOrchestrator,
} from '../../src/loop/work-loop.ts';
import { McpClientManager } from '../../src/mcp/mcp-client.ts';
import type { PrGroup } from '../../src/state/schema.ts';
import {
  createPlannerAgent,
  PLANNER_SYSTEM_PREFIX,
  runPlanner,
} from '../../src/subagents/planner.ts';
import {
  createReviewerAgent,
  REVIEWER_SYSTEM_PREFIX,
  runReviewer,
} from '../../src/subagents/reviewer.ts';
import { createWorkerAgent, runWorker, WORKER_SYSTEM_PREFIX } from '../../src/subagents/worker.ts';
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

// ---- LLM streams and sleeps, proven directly at the real chokepoint --------------------------
//
// The SIGINT test above proves child-process reaping end-to-end but stubs the LLM boundary
// (WorkLoopOrchestrator), per its own fidelity-boundary note. The two other surfaces a Ctrl-C must
// cut short — an in-flight LLM generation, and a poll's backoff sleep — are proven below directly at
// the real production chokepoint each subagent/GitHubClient actually goes through, with a real,
// still-ticking clock (not the instant-sleep test shortcut), asserting the cut lands within seconds
// rather than merely "eventually".

// A model whose doGenerate never settles on its own — it only rejects once the merged abortSignal
// fires. Mirrors ai-claude-compat/src/subagent.test.ts's stallingModel(): the same real
// createSubagent -> generate path a genuine Ctrl-C hits mid-Worker/Planner/Reviewer.
//
// `started` resolves the moment doGenerate is entered. Tests await it before aborting: an abort that
// lands first leaves an already-aborted signal, which never replays the event to a listener attached
// afterwards, so the generation would hang instead of rejecting. A timer can't rule that out.
type StallingModel = { model: MockLanguageModelV3; started: Promise<void> };

function stallingModel(): StallingModel {
  let generateStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    generateStarted = resolve;
  });
  const model = new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        const fail = (): void => {
          const reason = opts.abortSignal?.reason;
          reject(
            reason instanceof Error
              ? reason
              : new DOMException('This operation was aborted', 'AbortError'),
          );
        };
        // Belt and braces for a retry re-entered under an already-aborted signal.
        if (opts.abortSignal?.aborted) {
          generateStarted();
          fail();
          return;
        }
        opts.abortSignal?.addEventListener('abort', fail, { once: true });
        generateStarted();
      }),
  });
  return { model, started };
}

// Generous vs. real provider latency variance, and miles under any real per-step timeout or CI
// poll backoff — a hang that merely eventually settles would still blow well past this.
const CANCEL_BOUND_MS = 3000;

test('runWorker: a real Coordinator generation (not a stub) rejects within seconds of Ctrl-C', async () => {
  const controller = new AbortController();
  const stalling = stallingModel();
  // No tools are ever reached — the stalling model rejects on its very first generate, before the
  // Coordinator could make a tool call.
  const agent = createWorkerAgent({
    model: stalling.model,
    tools: {},
    systemPrompt: WORKER_SYSTEM_PREFIX,
    signal: controller.signal,
  });
  const group: PrGroup = {
    id: 'core',
    title: 'Core',
    tasks: [{ id: 't1', text: 'do it', complexity: 'normal', done: false }],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    stage: 'pending',
  };
  const running = runWorker(agent, {
    group,
    checkoutPath: '/tmp/aitm-sigint-worker',
    baseBranch: 'main',
    styleContents: '# style\n',
    rollingContext: '',
  });
  await stalling.started;
  const start = Date.now();
  controller.abort();
  const result = await running;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < CANCEL_BOUND_MS, `must reject within seconds, took ${elapsed}ms`);
  // runWorker never throws on abort — it catches and reports (see worker.ts's catch block).
  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.error : '', /abort/i);
});

test('runPlanner: a real generation (not a stub) rejects within seconds of Ctrl-C', async () => {
  const controller = new AbortController();
  const stalling = stallingModel();
  const agent = createPlannerAgent({
    model: stalling.model,
    tools: {},
    systemPrompt: PLANNER_SYSTEM_PREFIX,
    signal: controller.signal,
  });
  const running = runPlanner(agent, {
    goal: 'add hello',
    styleContents: '# style\n',
    maxPrs: 5,
  });
  await stalling.started;
  const start = Date.now();
  controller.abort();
  const result = await running;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < CANCEL_BOUND_MS, `must reject within seconds, took ${elapsed}ms`);
  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.error : '', /abort/i);
});

test('runReviewer: a real generation (not a stub) rejects within seconds of Ctrl-C', async () => {
  const controller = new AbortController();
  const stalling = stallingModel();
  const agent = createReviewerAgent({
    model: stalling.model,
    tools: {},
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
    signal: controller.signal,
  });
  const thread: ReviewThread = {
    id: 'thread-1',
    isResolved: false,
    path: 'src/example.ts',
    comments: [{ id: 'thread-1-c1', body: 'please fix', author: 'reviewer' }],
  };
  const running = runReviewer(agent, {
    pr: 1,
    threads: [thread],
    checkoutPath: '/tmp/aitm-sigint-reviewer',
    styleContents: '# style\n',
  });
  await stalling.started;
  const start = Date.now();
  controller.abort();
  const result = await running;
  const elapsed = Date.now() - start;
  assert.ok(elapsed < CANCEL_BOUND_MS, `must reject within seconds, took ${elapsed}ms`);
  // runReviewer never throws on abort either — same catch-and-report shape as runWorker.
  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.error : '', /abort/i);
});

// waitForChecks' production sleep (defaultSleep) collapses to a microtask under a detected test
// runner (github-client.ts isInstantSleepEnabled) so the rest of the suite doesn't burn real
// minutes on its 60s/backoff waits. This test needs a genuine, still-ticking timer to abort
// mid-flight, so it clears both detection env vars for its duration — mirrors
// github-client.test.ts's withRealTimers.
const INSTANT_SLEEP_ENV = ['AITM_INSTANT_SLEEP', 'NODE_TEST_CONTEXT'] as const;

async function withRealTimers(fn: () => Promise<void>): Promise<void> {
  const saved = INSTANT_SLEEP_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of INSTANT_SLEEP_ENV) delete process.env[key];
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('GitHubClient.waitForChecks: Ctrl-C mid grace-sleep returns within seconds (real 60s timer, not the test shortcut), no gh call', async () => {
  await withRealTimers(async () => {
    assert.equal(isInstantSleepEnabled(), false, 'precondition: real timers, not the fast path');
    const controller = new AbortController();
    let ghCalls = 0;
    const run: RunCmd = async () => {
      ghCalls += 1;
      throw new Error('gh must not be called — the abort must land during the start grace sleep');
    };
    const g = new GitHubClient('/tmp/repo', run);
    setTimeout(() => controller.abort(), 150);
    const start = Date.now();
    const result = await g.waitForChecks(1, controller.signal);
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < CANCEL_BOUND_MS,
      `must cut the real ${CHECKS_START_WAIT_MS}ms start grace short, took ${elapsed}ms`,
    );
    assert.equal(result.state, 'pending');
    assert.equal(ghCalls, 0, 'a cancelled grace wait must spawn no `gh pr checks`');
  });
});

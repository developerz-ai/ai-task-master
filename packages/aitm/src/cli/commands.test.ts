import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { RunLoopInput, RunMergeFlowInput } from '../composition/run-input.ts';
import type { LlmFetch } from '../credentials/llm-fetch.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import { Logger } from '../logger/logger.ts';
import { acquireRunLock } from '../state/run-lock.ts';
import { CURRENT_SCHEMA_VERSION, type RunState } from '../state/schema.ts';
import { makeTempRepo } from '../testing/temp-repo.ts';
import type { CommandExit, McpLoginCtx, RunPlannerInput, StartCtx } from './commands.ts';
import {
  drainStdin,
  isRunComplete,
  runClean,
  runConfig,
  runMcpLogin,
  runMergePr,
  runProfile,
  runResume,
  runStart,
} from './commands.ts';

const FAKE_KEY = 'sk-or-fake-test-key';

async function tempHome(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-home-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

function okAuth(): NonNullable<StartCtx['authStatus']> {
  return async () => ({ ok: true, scopes: ['repo'] });
}

function badAuth(): NonNullable<StartCtx['authStatus']> {
  return async () => ({ ok: false, scopes: [] });
}

const STUB_DIGEST = '# Coding Style\n\nstub digest\n';

// Stub the coding-style seam so unit tests never make a real LLM call via the default distiller.
function okStyle(): NonNullable<StartCtx['resolveStyle']> {
  return async () => STUB_DIGEST;
}

// Writes a schema-valid state.json so `runStart` takes the resume branch (state.read()
// succeeds). prGroups defaults to a single pre-populated group (a prior planning phase);
// pass `prGroups: []` to mirror a run whose planning blocked before persisting any plan.
async function seedStartState(
  repoPath: string,
  opts: { prGroups?: unknown[] } = {},
): Promise<void> {
  const dir = join(repoPath, '.ai-task-master');
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    status: 'working',
    prGroups: opts.prGroups ?? [
      {
        id: 'seeded',
        title: 'seeded group',
        tasks: [{ id: 'existing-task', text: 'existing task', complexity: 'normal', done: false }],
        dependsOn: [],
        branch: 'aitm/seeded',
        pr: null,
        status: 'pending',
      },
    ],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'run-resume',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    agentConfigFile: 'CLAUDE.md',
    createdAt: now,
    updatedAt: now,
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
  };
  await writeFile(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

// Stub for the `github` slot on MergePrCtx — short-circuits the precondition path
// that would otherwise shell out to git on a freshly-initialised temp repo with no
// commits and no branches.
function stubGithub(opts: {
  currentBranch: string;
  prForBranch: { number: number } | null;
}): import('../github/github-client.ts').GitHubClient {
  const stub = {
    currentBranch: async () => opts.currentBranch,
    getPrForBranch: async () => opts.prForBranch,
  };
  return stub as unknown as import('../github/github-client.ts').GitHubClient;
}

// ---- runStart ---------------------------------------------------------------

test('runStart: happy path → initialises state, calls runLoop, exits 0', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let loopCalls = 0;
    let captured: RunLoopInput | null = null;
    const result = await runStart(
      { kind: 'start', goal: 'add jwt auth', criteria: 'tests pass' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async (input) => {
          loopCalls++;
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(loopCalls, 1);
    assert.ok(captured, 'runLoop received input');
    assert.equal(captured?.styleDigest, STUB_DIGEST, 'resolved digest threaded to runLoop');
    const stateRaw = await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8');
    const persisted = JSON.parse(stateRaw) as { status: string; options: { autoMerge: boolean } };
    assert.equal(persisted.status, 'planning');
    assert.equal(persisted.options.autoMerge, true);
    const goal = await readFile(join(repo.path, '.ai-task-master', 'goal.txt'), 'utf8');
    assert.equal(goal.trim(), 'add jwt auth');
    const criteria = await readFile(join(repo.path, '.ai-task-master', 'criteria.txt'), 'utf8');
    assert.equal(criteria.trim(), 'tests pass');
    const snapshot = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'config.snapshot.json'), 'utf8'),
    ) as { openrouterApiKey: string };
    assert.match(snapshot.openrouterApiKey, /<from env>/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: constructs a Logger and threads it into the loop input (finding 06/arch-1)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let captured: RunLoopInput | null = null;
    const result = await runStart(
      { kind: 'start', goal: 'add jwt auth' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    // Before this wiring every `logger?.warn(...)` in the loop was a runtime no-op — the loop never
    // received a Logger. Assert a real one now reaches the adapter so those diagnostics can fire.
    assert.ok(captured?.logger instanceof Logger, 'a live Logger is threaded to the loop');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: releases the run lock when the run ends', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'add jwt auth' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0, result.message);
    await assert.rejects(
      () => readFile(join(repo.path, '.ai-task-master', 'run.lock'), 'utf8'),
      /ENOENT/,
      'lock released so the next run can start',
    );
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// A stand-in for the keep-alive transport handle, counting releases. The real one owns an undici
// pool whose idle sockets hold the event loop open, so "was it closed" is the behaviour to pin.
function countingLlmFetch(): { make: () => Promise<LlmFetch>; closes: () => number } {
  let closes = 0;
  const handle: LlmFetch = {
    fetch: () => Promise.resolve(new Response('ok')),
    close: async () => {
      closes += 1;
    },
  };
  return { make: async () => handle, closes: () => closes };
}

test('runStart: releases the keep-alive transport when the run ends', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const llm = countingLlmFetch();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'add jwt auth' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        makeLlmFetch: llm.make,
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(llm.closes(), 1, 'the undici pool is closed, not leaked past the run');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: a throwing loop still releases the keep-alive transport', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const llm = countingLlmFetch();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'add jwt auth' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        makeLlmFetch: llm.make,
        runLoop: async () => {
          throw new Error('loop exploded');
        },
      },
    );
    assert.equal(result.code, 1);
    assert.equal(llm.closes(), 1);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: another run holds the state dir → exit 1, loop never runs', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await acquireRunLock(join(repo.path, '.ai-task-master'));
    let loopCalls = 0;
    const result = await runStart(
      { kind: 'start', goal: 'add jwt auth' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => {
          loopCalls++;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /another aitm run holds/);
    assert.equal(loopCalls, 0, 'no work started against a locked state dir');
    // The refusal must leave the holder's lock alone.
    assert.ok(await readFile(join(repo.path, '.ai-task-master', 'run.lock'), 'utf8'));
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: prints the auto-merge banner to stdout when auto-merge is on (default)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let out = '';
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        stdout: (chunk) => {
          out += chunk;
        },
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.match(out, /auto-merge is ON/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: --no-automerge suppresses the banner', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let out = '';
    const result = await runStart(
      { kind: 'start', goal: 'g', autoMerge: false },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        stdout: (chunk) => {
          out += chunk;
        },
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
        // Stubbed so this assertion tests the auto-merge banner, not whether the model catalog was
        // reachable — the real one prints a table whose presence depends on a network round-trip.
        modelBanner: async () => '',
      },
    );
    assert.equal(result.code, 0, result.message);
    // The banner is suppressed, but the end-of-run usage summary is always written (issue #114).
    assert.ok(!out.includes('auto-merge is ON'), 'no auto-merge banner');
    assert.match(out, /^Usage: /, 'usage summary line still written');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: --pr-per-task with --no-automerge → exit 1, loop never runs', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    // The combo is rejected right after config resolution — before detect/auth/state/loop — so no
    // plan is persisted and the loop never starts.
    const result = await runStart(
      { kind: 'start', goal: 'g', prPerTask: true, autoMerge: false },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        runLoop: async () => {
          assert.fail('runLoop must not run for a rejected flag combo');
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /--pr-per-task/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: --pr-per-task with config autoMerge:false → exit 1 (config path, not just flag)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    // auto-merge disabled via project config, prPerTask via flag: the resolved-config guard must
    // still reject it — an args-only (flag-combo) check would miss this path.
    const dir = join(repo.path, '.ai-task-master');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), `${JSON.stringify({ autoMerge: false })}\n`);
    const result = await runStart(
      { kind: 'start', goal: 'g', prPerTask: true },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        runLoop: async () => {
          assert.fail('runLoop must not run for a rejected config combo');
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /--pr-per-task/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: missing API key → exit 1 with actionable message', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: {},
        authStatus: okAuth(),
        runLoop: async () => {
          assert.fail('runLoop must not be called when API key is missing');
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /OPENROUTER_API_KEY|API key/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: no CLAUDE.md/AGENTS.md and no --style → proceeds with a default style (no abort)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: false });
  const home = await tempHome();
  try {
    let loopCalls = 0;
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => {
          loopCalls++;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(
      result.code,
      0,
      'runs on a bare repo instead of aborting on the missing style file',
    );
    assert.equal(loopCalls, 1, 'reached the run loop past the style gate');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: no CLAUDE.md/AGENTS.md notice goes through ctx.stderr, not bare process.stderr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: false });
  const home = await tempHome();
  try {
    const err = collectStdout();
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        stderr: err.out,
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0);
    assert.match(err.text(), /No CLAUDE\.md or AGENTS\.md/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: gh not authenticated → exit 1', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: badAuth(),
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /gh.*auth|gh auth login/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: authStatus throws → exit 1 carrying error message', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: async () => {
          throw new Error('gh binary missing');
        },
        runLoop: async () => {
          assert.fail('runLoop must not run when auth check throws');
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /gh binary missing/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: WorkLoopResult.blocked → exit 1 carrying reason', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => ({
          kind: 'blocked',
          reason: 'planner refused',
          outcomes: [],
        }),
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /planner refused/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: awaiting-pr (--no-automerge) → exit 0 with merge-pr instruction', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'g', autoMerge: false },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => ({ kind: 'awaiting-pr', prs: [17], outcomes: [] }),
      },
    );
    assert.equal(result.code, 0);
    assert.match(result.message ?? '', /17/);
    assert.match(result.message ?? '', /aitm merge-pr/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: loop cancelled → exit 2', async () => {
  // cancel→exit2: WorkLoopResult.cancelled maps to exit code 2 for the start command too.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => ({ kind: 'cancelled', outcomes: [] }),
      },
    );
    assert.equal(result.code, 2);
    assert.match(result.message ?? '', /cancel/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: session-cap → exit 0', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => ({ kind: 'session-cap', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0);
    assert.match(result.message ?? '', /session cap/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: CLI overrides reach the persisted run state', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await runStart(
      {
        kind: 'start',
        goal: 'g',
        maxPrs: 3,
        autoMerge: false,
        concurrency: 2,
      },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as { options: { maxPrs: number; autoMerge: boolean; concurrency: number } };
    assert.equal(persisted.options.maxPrs, 3);
    assert.equal(persisted.options.autoMerge, false);
    assert.equal(persisted.options.concurrency, 2);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: --max-fix-attempts reaches the resolved config handed to the loop (issue #128)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let seen: number | undefined;
    await runStart(
      { kind: 'start', goal: 'g', maxFixAttempts: 2 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async (input) => {
          seen = input.resolved.maxCiFixAttempts;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(seen, 2);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: without --max-fix-attempts the loop gets the default cap (issue #128)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let seen: number | undefined;
    await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async (input) => {
          seen = input.resolved.maxCiFixAttempts;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(seen, 3);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: threads the resolved llmStepTimeoutMs into both the style-digest seam and the loop (issue #129)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let styleSeen: number | undefined;
    let loopSeen: number | undefined;
    await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: async (input) => {
          styleSeen = input.llmStepTimeoutMs;
          return STUB_DIGEST;
        },
        runLoop: async (input) => {
          loopSeen = input.resolved.llmStepTimeoutMs;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(styleSeen, 900_000, 'style-digest call gets the default deadline');
    assert.equal(loopSeen, 900_000, 'the loop gets the default deadline');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- runStart: planning phase (issue #17) -----------------------------------

test('runStart: fresh run invokes runPlanner before runLoop, persists prGroups + status working', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const seq: string[] = [];
    let plannerInput: RunPlannerInput | null = null;
    const groups = [
      {
        id: 'hello',
        title: 'add hello.txt',
        tasks: [
          {
            id: 'create-hello',
            text: 'create hello.txt with the word hi',
            complexity: 'normal',
            done: false,
          },
        ],
        dependsOn: [],
        branch: 'aitm/hello',
        pr: null,
        status: 'pending' as const,
      },
    ];
    const result = await runStart(
      { kind: 'start', goal: 'add a hello.txt with the word hi', criteria: 'file exists' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runPlanner: async (input) => {
          seq.push('plan');
          plannerInput = input;
          return { kind: 'ok', groups };
        },
        runLoop: async () => {
          seq.push('loop');
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    // Planning is a one-shot phase that runs once, before the loop.
    assert.deepEqual(seq, ['plan', 'loop']);
    assert.equal(plannerInput?.goal, 'add a hello.txt with the word hi');
    assert.equal(plannerInput?.criteria, 'file exists');
    // Plan persisted: prGroups populated, status flipped planning → working.
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as { status: string; prGroups: { id: string; status: string }[] };
    assert.equal(persisted.status, 'working');
    assert.equal(persisted.prGroups.length, 1);
    assert.equal(persisted.prGroups[0]?.id, 'hello');
    assert.equal(persisted.prGroups[0]?.status, 'pending');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: resume (existing state.json) skips runPlanner, preserves prior prGroups', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedStartState(repo.path);
    let plannerCalls = 0;
    const result = await runStart(
      { kind: 'start', goal: 'add hello' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runPlanner: async () => {
          plannerCalls++;
          return { kind: 'ok', groups: [] };
        },
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(plannerCalls, 0, 'planner must not run on resume — prGroups already persisted');
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as { prGroups: { id: string }[] };
    assert.equal(persisted.prGroups[0]?.id, 'seeded');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: an unparseable state.json is replaced, not treated as a run to protect', async () => {
  // StateStore.init refuses a clobber by default; a state.json too corrupt to resume is one of the
  // two cases start is entitled to overwrite, so it must pass force rather than fail to start.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const dir = join(repo.path, '.ai-task-master');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), '{not json');
    let plannerGoal: string | undefined;
    const result = await runStart(
      { kind: 'start', goal: 'add hello' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        modelBanner: async () => '',
        runPlanner: async (input) => {
          plannerGoal = input.goal;
          return { kind: 'ok', groups: [] };
        },
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(plannerGoal, 'add hello', 'the run started fresh instead of refusing');
    const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as {
      runId: string;
    };
    assert.ok(persisted.runId.length > 0);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: a state.json from a newer aitm is refused, never replaced', async () => {
  // The contrast with the unparseable case above: a file this build cannot read is not a corrupt
  // one. Forcing a fresh init over it would destroy a live run purely over a version gap.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const dir = join(repo.path, '.ai-task-master');
    await mkdir(dir, { recursive: true });
    const future = JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1, runId: 'from-v2' });
    await writeFile(join(dir, 'state.json'), future);
    let plannerCalls = 0;
    const result = await runStart(
      { kind: 'start', goal: 'add hello' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        modelBanner: async () => '',
        runPlanner: async () => {
          plannerCalls += 1;
          return { kind: 'ok', groups: [] };
        },
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 1, 'the run must refuse to start');
    assert.match(result.message ?? '', /newer aitm/);
    assert.equal(plannerCalls, 0, 'nothing may run on top of a state file we cannot read');
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), future, 'file untouched');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: resume with empty prGroups (prior planning blocked) re-runs runPlanner', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    // A prior run initialised state.json but its planning blocked before persisting any plan.
    await seedStartState(repo.path, { prGroups: [] });
    let plannerCalls = 0;
    const groups = [
      {
        id: 'replanned',
        title: 'replanned group',
        tasks: [{ id: 'do-the-work', text: 'do the work', complexity: 'normal', done: false }],
        dependsOn: [],
        branch: 'aitm/replanned',
        pr: null,
        status: 'pending' as const,
      },
    ];
    const result = await runStart(
      { kind: 'start', goal: 'add hello' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runPlanner: async () => {
          plannerCalls++;
          return { kind: 'ok', groups };
        },
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(plannerCalls, 1, 'planner must re-run when no plan is persisted yet');
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as { status: string; prGroups: { id: string }[] };
    assert.equal(persisted.status, 'working');
    assert.equal(persisted.prGroups[0]?.id, 'replanned');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: runPlanner blocked → exit 1 with reason, runLoop not invoked', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'unbuildable' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        runPlanner: async () => ({ kind: 'blocked', reason: 'goal is not actionable' }),
        runLoop: async () => {
          assert.fail('runLoop must not run when planning blocks');
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /goal is not actionable/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- runStart: coding-style digest ------------------------------------------

test('runStart: default resolveStyle reuses cached coding-style.md (no LLM call)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    // A prior run already distilled + cached the digest; resume must reuse it, not re-distill.
    await seedStartState(repo.path);
    const cached = '# Coding Style\n\ncached digest\n';
    await writeFile(join(repo.path, '.ai-task-master', 'coding-style.md'), cached);
    let captured: RunLoopInput | null = null;
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        // No resolveStyle stub → exercises defaultResolveStyle; the cache hit avoids any LLM call.
        runLoop: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    const style = captured?.styleDigest ?? '';
    assert.match(style, /cached digest/, 'cached digest reused, no LLM call');
    // The verbatim half is re-composed every run, so a CLAUDE.md edit is never pinned by the cache.
    const claudeMd = await readFile(join(repo.path, 'CLAUDE.md'), 'utf8');
    assert.ok(style.includes(claudeMd.trim()), 'CLAUDE.md still reaches prompts verbatim');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runStart: resolveStyle failure never blocks → falls back to raw agent-config contents', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const claudeMd = await readFile(join(repo.path, 'CLAUDE.md'), 'utf8');
    let captured: RunLoopInput | null = null;
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: async () => {
          throw new Error('distiller exploded');
        },
        runLoop: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(captured?.styleDigest, claudeMd, 'falls back to raw contents, run not blocked');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- runMergePr -------------------------------------------------------------

type SeedPatch = {
  currentPr?: number | null;
  stylePath?: string | null;
  status?: RunState['status'];
  prGroups?: readonly PrGroup[];
  currentGroupIndex?: number;
  sessionCount?: number;
  runId?: string;
};

// A run caught mid-plan: group one merged, group two holding the open PR. `--no-resume` must
// re-point `currentPr` at the taken-over PR without costing the operator any of this.
function midPlanSeed(): SeedPatch {
  const task = (id: string, done: boolean): PrGroup['tasks'][number] => ({
    id,
    text: `task ${id}`,
    complexity: 'normal',
    done,
  });
  return {
    status: 'working',
    currentPr: 73,
    currentGroupIndex: 1,
    sessionCount: 3,
    runId: 'run-midplan',
    prGroups: [
      {
        id: 'g1',
        title: 'schema',
        tasks: [task('t1', true)],
        dependsOn: [],
        branch: 'feat/schema',
        pr: 70,
        status: 'merged',
        stage: 'merged',
      },
      {
        id: 'g2',
        title: 'api',
        tasks: [task('t2', true), task('t3', false)],
        dependsOn: ['g1'],
        branch: 'feat/api',
        pr: 73,
        status: 'awaiting-pr',
        stage: 'waiting-ci',
      },
    ],
  };
}

async function seedState(repoPath: string, patch: SeedPatch = {}): Promise<void> {
  const dir = join(repoPath, '.ai-task-master');
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    status: patch.status ?? 'awaiting-pr',
    prGroups: patch.prGroups ?? [],
    currentGroupIndex: patch.currentGroupIndex ?? 0,
    currentTaskIndex: 0,
    sessionCount: patch.sessionCount ?? 0,
    currentPr: 'currentPr' in patch ? patch.currentPr : 42,
    runId: patch.runId ?? 'run-test',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    agentConfigFile: 'CLAUDE.md',
    createdAt: now,
    updatedAt: now,
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: patch.stylePath ?? null,
      concurrency: 1,
    },
  };
  await writeFile(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

test('runMergePr: happy path with --pr override', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    let captured: RunMergeFlowInput | null = null;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 99 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.ok(captured, 'flow was called');
    assert.equal(captured?.pr, 99);
    assert.equal(captured?.resume, true);
    assert.equal(captured?.styleDigest, STUB_DIGEST, 'resolved digest threaded to merge flow');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: config-resolution warnings go through ctx.stderr, not bare process.stderr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    const dir = join(repo.path, '.ai-task-master');
    await mkdir(dir, { recursive: true });
    // An unknown project config key is a ConfigLoader-level warning (routed via the injected `warn`
    // option), distinct from the CommandExit error path — this is what proves the seam is wired.
    await writeFile(join(dir, 'config.json'), `${JSON.stringify({ bogusKey: true })}\n`);
    const err = collectStdout();
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 99 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        stderr: err.out,
        runMergeFlow: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.match(err.text(), /unknown config key "bogusKey"/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: constructs a Logger and threads it into the merge flow (finding 06/arch-1)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    let captured: RunMergeFlowInput | null = null;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 99 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.ok(
      captured?.logger instanceof Logger,
      'a live Logger is threaded to the take-over flow',
    );
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: builds a usage tracker, threads it to the flow, and flushes totals (#190)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    let out = '';
    let captured: RunMergeFlowInput | null = null;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 99 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        stdout: (chunk) => {
          out += chunk;
        },
        runMergeFlow: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.ok(captured?.usage, 'usage tracker threaded to the merge flow');
    assert.match(out, /^Usage: /m, 'end-of-run usage summary printed');
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as { usage?: unknown };
    assert.ok(persisted.usage, 'usage totals persisted to state');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: releases the keep-alive transport when the flow ends', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const llm = countingLlmFetch();
  try {
    await seedState(repo.path);
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 99 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        makeLlmFetch: llm.make,
        runMergeFlow: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(llm.closes(), 1);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: another run holds the state dir → exit 1, flow never runs', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    await acquireRunLock(join(repo.path, '.ai-task-master'));
    let flowCalls = 0;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 99 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async () => {
          flowCalls++;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /another aitm run holds/);
    assert.equal(flowCalls, 0, 'no merge flow against a locked state dir');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: threads --max-iterations through to the flow', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    let captured: RunMergeFlowInput | null = null;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 12, maxIterations: 7 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(captured?.maxIterations, 7);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: flow cancelled → exit 2', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 5 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async () => ({ kind: 'cancelled', outcomes: [] }),
      },
    );
    assert.equal(result.code, 2);
    assert.match(result.message ?? '', /cancel/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: flow blocked (iteration cap exhausted) → exit 1', async () => {
  // cap→exit1: when the merge-pr take-over loop exhausts maxIterations, the flow returns blocked.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 5 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async () => ({
          kind: 'blocked',
          reason: 'iteration cap reached: 30 iterations without merge',
          outcomes: [],
        }),
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /iteration cap/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: flow blocked (rebase conflict) → exit 1', async () => {
  // conflict→exit1: a git rebase conflict during force-push blocks the flow → exit 1.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 5 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async () => ({
          kind: 'blocked',
          reason: 'git rebase onto origin/main hit conflicts that need manual resolution',
          outcomes: [],
        }),
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /conflict|rebase/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: falls back to state.currentPr when --pr absent', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path, { currentPr: 73 });
    let prSeen: number | undefined;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async (input) => {
          prSeen = input.pr;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(prSeen, 73);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: resume false ignores stale persisted currentPr, takes over current branch', async () => {
  // `--no-resume` must not trust a prior run's persisted currentPr (73 here) — it should
  // force the take-over flow and resolve the PR from the current branch instead.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path, { currentPr: 73 });
    let prSeen: number | undefined;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: false },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async (input) => {
          prSeen = input.pr;
          return { kind: 'success', outcomes: [] };
        },
        github: stubGithub({ currentBranch: 'feature-branch', prForBranch: { number: 99 } }),
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(prSeen, 99, 'PR resolved from current branch, not the stale persisted currentPr');
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as { currentPr: number };
    assert.equal(persisted.currentPr, 99, 'state.json re-pointed at the take-over PR');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: resume false on a mid-plan run → re-points currentPr, keeps the plan', async () => {
  // `--no-resume` distrusts one field. Replacing the whole state with a synthesized take-over
  // state would cost the operator the plan, group stages, session count and runId.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path, midPlanSeed());
    let captured: RunMergeFlowInput | null = null;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: false, pr: 88 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(captured?.pr, 88, 'take-over PR wins over the persisted currentPr');
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as RunState;
    assert.equal(persisted.currentPr, 88, 'currentPr updated in place');
    assert.deepEqual(
      persisted.prGroups.map((g) => `${g.id}:${g.stage}:${g.pr}`),
      ['g1:merged:70', 'g2:waiting-ci:73'],
      'plan, group stages and per-group PRs survive --no-resume',
    );
    assert.equal(persisted.runId, 'run-midplan', 'runId kept → prompt-cache session stays sticky');
    assert.equal(persisted.status, 'working');
    assert.equal(persisted.currentGroupIndex, 1);
    assert.equal(persisted.sessionCount, 3);
    assert.equal(captured?.runState.runId, 'run-midplan', 'flow sees the preserved run');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: resume false with no prior state → synthesizes and persists take-over', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let prSeen: number | undefined;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: false, pr: 42 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async (input) => {
          prSeen = input.pr;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(prSeen, 42);
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as RunState;
    assert.equal(persisted.currentPr, 42);
    assert.equal(persisted.status, 'awaiting-pr');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: resume false with unreadable state → exit 1, file untouched', async () => {
  // Distrusting the persisted PR number is not licence to rewrite a file aitm cannot read: the
  // operator fixes or deletes it, so whatever it holds is still theirs to recover.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const dir = join(repo.path, '.ai-task-master');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), '{ not json');
    let flowCalls = 0;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: false, pr: 88 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async () => {
          flowCalls++;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /unreadable/);
    assert.equal(flowCalls, 0, 'no merge flow against unreadable state');
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), '{ not json', 'file untouched');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: no state file + --pr synthesizes state and runs the flow', async () => {
  // Take-over flow: user opened the PR by hand (Claude Code, `gh pr create`) and
  // never ran `aitm start`. `aitm merge-pr --pr N` must auto-init state and proceed,
  // not error with "did you run aitm start?".
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let flowPr: number | null = null;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true, pr: 42 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runMergeFlow: async (input) => {
          flowPr = input.pr;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(flowPr, 42);
    // Persisted so the next call resumes without --pr.
    const persisted = JSON.parse(
      await readFile(join(repo.path, '.ai-task-master', 'state.json'), 'utf8'),
    ) as { currentPr: number; status: string };
    assert.equal(persisted.currentPr, 42);
    assert.equal(persisted.status, 'awaiting-pr');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: no state, no --pr, no branch PR → exit 1 with help', async () => {
  // Stubbed github so we don't actually shell out to git on the temp repo (which has
  // no commits or branches). Exercises the precondition path: no --pr, no current PR.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        runMergeFlow: async () => {
          assert.fail('flow must not run when no PR can be discovered');
        },
        github: stubGithub({ currentBranch: 'main', prForBranch: null }),
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /no open PR found|--pr/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: missing API key → exit 1, flow not invoked', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    let called = false;
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: {},
        authStatus: okAuth(),
        runMergeFlow: async () => {
          called = true;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 1);
    assert.equal(called, false);
    assert.match(result.message ?? '', /OPENROUTER_API_KEY|API key/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: authStatus throws → exit 1 carrying error message', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path);
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: async () => {
          throw new Error('gh binary missing');
        },
        runMergeFlow: async () => {
          assert.fail('flow must not run when auth check throws');
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /gh binary missing/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runMergePr: no --pr and no currentPr → exit 1', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedState(repo.path, { currentPr: null });
    const result = await runMergePr(
      { kind: 'merge-pr', resume: true },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        runMergeFlow: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /--pr|currentPr|PR to merge/i);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- runConfig --------------------------------------------------------------

test('runConfig set → file persisted, exit 0', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    const result = await runConfig(
      {
        kind: 'config-set',
        scope: 'global',
        key: 'models.smart',
        value: 'anthropic/claude-opus-4.7',
      },
      { cwd: repo.path, homeDir: home.path },
    );
    assert.equal(result.code, 0, result.message);
    const raw = await readFile(join(home.path, '.aitm.json'), 'utf8');
    const parsed = JSON.parse(raw) as { models?: { smart?: string } };
    assert.equal(parsed.models?.smart, 'anthropic/claude-opus-4.7');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig get → prints value, exit 0', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    await writeFile(join(home.path, '.aitm.json'), JSON.stringify({ maxPrs: 7 }));
    const writes: string[] = [];
    const result = await runConfig(
      { kind: 'config-get', scope: 'global', key: 'maxPrs' },
      {
        cwd: repo.path,
        homeDir: home.path,
        stdout: (s) => {
          writes.push(s);
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(writes.join(''), '7\n');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig list → prints JSON, exit 0', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    await writeFile(join(home.path, '.aitm.json'), JSON.stringify({ maxPrs: 4 }));
    const writes: string[] = [];
    const result = await runConfig(
      { kind: 'config-list', scope: 'global', effective: false },
      {
        cwd: repo.path,
        homeDir: home.path,
        stdout: (s) => {
          writes.push(s);
        },
      },
    );
    assert.equal(result.code, 0);
    const printed = JSON.parse(writes.join('').trim()) as { maxPrs: number };
    assert.equal(printed.maxPrs, 4);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig list → masks openrouterApiKey (no cleartext leak)', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    const secret = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    await writeFile(join(home.path, '.aitm.json'), JSON.stringify({ openrouterApiKey: secret }));
    const writes: string[] = [];
    const result = await runConfig(
      { kind: 'config-list', scope: 'global', effective: false },
      {
        cwd: repo.path,
        homeDir: home.path,
        stdout: (s) => {
          writes.push(s);
        },
      },
    );
    assert.equal(result.code, 0);
    const out = writes.join('');
    assert.ok(!out.includes(secret), 'full API key must not appear in config list output');
    const printed = JSON.parse(out.trim()) as { openrouterApiKey: string };
    assert.match(
      printed.openrouterApiKey,
      /^sk-or-…[A-Za-z0-9]{4}$/,
      'masked key should keep sk-or- prefix and last 4 chars',
    );
    assert.ok(
      printed.openrouterApiKey.endsWith('cdef'),
      'last 4 chars retained for identification',
    );
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig list --effective → merged config with per-key source labels, exit 0', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    await writeFile(
      join(home.path, '.aitm.json'),
      JSON.stringify({ maxPrs: 7, openrouterApiKey: 'sk-or-v1-0123456789abcdef' }),
    );
    const writes: string[] = [];
    const result = await runConfig(
      { kind: 'config-list', scope: 'global', effective: true },
      { cwd: repo.path, homeDir: home.path, env: {}, stdout: (s) => writes.push(s) },
    );
    assert.equal(result.code, 0);
    const out = writes.join('');
    assert.match(out, /default < profile < global < project < env < CLI/);
    assert.match(out, /\nmaxPrs\t7\tglobal\n/);
    assert.match(out, /\nmaxSessions\tnull\tdefault\n/, 'unset scalar shows default');
    assert.match(out, /\nbashRules\t\d+ rules \(first-match-wins\)\tmerged\n/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig list --effective → api key masked and labeled by its source', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    const secret = 'sk-or-v1-0123456789abcdef';
    const writes: string[] = [];
    const result = await runConfig(
      { kind: 'config-list', scope: 'global', effective: true },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: secret },
        stdout: (s) => writes.push(s),
      },
    );
    assert.equal(result.code, 0);
    const out = writes.join('');
    assert.ok(!out.includes(secret), 'full API key must never be printed');
    assert.match(out, /\nopenrouterApiKey\tsk-or-…cdef\tenv\n/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig list --effective → resolution warnings route to ctx.stderr, not stdout', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    await writeFile(
      join(home.path, '.aitm.json'),
      JSON.stringify({ openrouterApiKey: 'sk-or-v1-0123456789abcdef', bogusKey: 1 }),
    );
    const writes: string[] = [];
    const errs: string[] = [];
    const result = await runConfig(
      { kind: 'config-list', scope: 'global', effective: true },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: {},
        stdout: (s) => writes.push(s),
        stderr: (s) => errs.push(s),
      },
    );
    assert.equal(result.code, 0);
    assert.match(errs.join(''), /unknown config key "bogusKey"/);
    assert.ok(!writes.join('').includes('bogusKey'), 'warning must not pollute stdout');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig list --effective → no credentials surfaces the actionable error, exit 1', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    const result = await runConfig(
      { kind: 'config-list', scope: 'global', effective: true },
      { cwd: repo.path, homeDir: home.path, env: {}, stdout: () => {} },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /No OpenRouter API key found/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig unset → key removed, exit 0', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    await writeFile(join(home.path, '.aitm.json'), JSON.stringify({ maxPrs: 4 }));
    const result = await runConfig(
      { kind: 'config-unset', scope: 'global', key: 'maxPrs' },
      { cwd: repo.path, homeDir: home.path },
    );
    assert.equal(result.code, 0);
    const parsed = JSON.parse(await readFile(join(home.path, '.aitm.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(parsed.maxPrs, undefined);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runConfig set with invalid value → exit 1', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  try {
    const result = await runConfig(
      { kind: 'config-set', scope: 'global', key: 'maxPrs', value: '"five"' },
      { cwd: repo.path, homeDir: home.path },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /maxPrs/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- Type smoke -------------------------------------------------------------

test('CommandExit narrows to documented codes', () => {
  const ok: CommandExit = { code: 0 };
  const bad: CommandExit = { code: 1, message: 'x' };
  const cancelled: CommandExit = { code: 2 };
  assert.equal(ok.code, 0);
  assert.equal(bad.code, 1);
  assert.equal(cancelled.code, 2);
});

// ---- runProfile ------------------------------------------------------------

function collectStdout(): { chunks: string[]; out: (c: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { chunks, out: (c) => chunks.push(c), text: () => chunks.join('') };
}

test('runProfile: add then list shows the profile with a masked key', async () => {
  const home = await tempHome();
  try {
    const add = await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai', apiKey: 'sk-or-supersecret-1234' },
      { homeDir: home.path, stdout: () => {} },
    );
    assert.equal(add.code, 0);
    const sink = collectStdout();
    const list = await runProfile(
      { kind: 'profile-list' },
      { homeDir: home.path, stdout: sink.out },
    );
    assert.equal(list.code, 0);
    const text = sink.text();
    assert.match(text, /\* z\.ai/); // active marker
    assert.match(text, /api\.z\.ai/);
    assert.doesNotMatch(text, /supersecret/, 'raw key must never be printed');
  } finally {
    await home.cleanup();
  }
});

test('runProfile: add --api-key-stdin reads the key from stdin (never argv)', async () => {
  const home = await tempHome();
  try {
    const err = collectStdout();
    const add = await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai', apiKeyStdin: true },
      {
        homeDir: home.path,
        stdout: () => {},
        stderr: err.out,
        readStdin: async () => 'sk-or-fromstdin-9999\n',
      },
    );
    assert.equal(add.code, 0);
    assert.equal(err.text(), '', 'stdin path must not emit the argv warning');
    const cfg = JSON.parse(await readFile(join(home.path, '.aitm.json'), 'utf8')) as {
      profiles?: Record<string, { openrouterApiKey?: string }>;
    };
    assert.equal(cfg.profiles?.['z.ai']?.openrouterApiKey, 'sk-or-fromstdin-9999');
  } finally {
    await home.cleanup();
  }
});

test('runProfile: add --api-key on argv still works but warns about exposure', async () => {
  const home = await tempHome();
  try {
    const err = collectStdout();
    const add = await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai', apiKey: 'sk-or-argv-1234' },
      { homeDir: home.path, stdout: () => {}, stderr: err.out },
    );
    assert.equal(add.code, 0);
    assert.match(err.text(), /--api-key-stdin/);
    assert.match(err.text(), /process listings|shell history/);
  } finally {
    await home.cleanup();
  }
});

test('runProfile: add --api-key-stdin with empty stdin exits 1', async () => {
  const home = await tempHome();
  try {
    const res = await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai', apiKeyStdin: true },
      { homeDir: home.path, stdout: () => {}, readStdin: async () => '  \n' },
    );
    assert.equal(res.code, 1);
    assert.match(res.message ?? '', /stdin/);
  } finally {
    await home.cleanup();
  }
});

test('drainStdin: timeout interrupts an open-but-idle stream (never a chunk)', async () => {
  const stream = new PassThrough(); // stays open, emits no data, never ends
  await assert.rejects(drainStdin({ stream, timeoutMs: 50 }), /timed out after 50ms/);
});

test('drainStdin: abort interrupts an open-but-idle stream mid-read', async () => {
  const stream = new PassThrough();
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('aborted-mid-read')), 10);
  await assert.rejects(
    drainStdin({ stream, timeoutMs: 60_000, signal: ac.signal }),
    /aborted-mid-read/,
  );
});

test('drainStdin: already-aborted signal rejects before reading', async () => {
  const stream = new PassThrough();
  await assert.rejects(
    drainStdin({ stream, signal: AbortSignal.abort(new Error('pre-aborted')) }),
    /pre-aborted/,
  );
});

test('drainStdin: reads piped chunks then resolves on end', async () => {
  const stream = new PassThrough();
  stream.write('sk-or-');
  stream.write('piped-123\n');
  stream.end();
  assert.equal(await drainStdin({ stream, timeoutMs: 5_000 }), 'sk-or-piped-123\n');
});

test('drainStdin: rejects when data exceeds maxBytes', async () => {
  const stream = new PassThrough();
  stream.write('x'.repeat(50));
  await assert.rejects(drainStdin({ stream, maxBytes: 10, timeoutMs: 5_000 }), /maximum size/);
});

test('runProfile: use on an unknown profile exits 1 with a helpful message', async () => {
  const home = await tempHome();
  try {
    const res = await runProfile(
      { kind: 'profile-use', name: 'ghost' },
      { homeDir: home.path, stdout: () => {} },
    );
    assert.equal(res.code, 1);
    assert.match(res.message ?? '', /Unknown profile "ghost"/);
  } finally {
    await home.cleanup();
  }
});

test('runProfile: show masks the key in its JSON output', async () => {
  const home = await tempHome();
  try {
    await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai', apiKey: 'sk-or-supersecret-1234' },
      { homeDir: home.path, stdout: () => {} },
    );
    const sink = collectStdout();
    const res = await runProfile(
      { kind: 'profile-show' },
      { homeDir: home.path, stdout: sink.out },
    );
    assert.equal(res.code, 0);
    assert.doesNotMatch(sink.text(), /supersecret/);
  } finally {
    await home.cleanup();
  }
});

test('runProfile: get returns a single field value', async () => {
  const home = await tempHome();
  try {
    await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai' },
      { homeDir: home.path, stdout: () => {} },
    );
    const sink = collectStdout();
    const res = await runProfile(
      { kind: 'profile-get', name: 'z.ai', key: 'baseURL' },
      { homeDir: home.path, stdout: sink.out },
    );
    assert.equal(res.code, 0);
    assert.equal(sink.text().trim(), 'https://api.z.ai/api/coding/paas/v4');
  } finally {
    await home.cleanup();
  }
});

test('runProfile: rename renames the profile and reports success', async () => {
  const home = await tempHome();
  try {
    await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai' },
      { homeDir: home.path, stdout: () => {} },
    );
    const sink = collectStdout();
    const res = await runProfile(
      { kind: 'profile-rename', from: 'z.ai', to: 'zed' },
      { homeDir: home.path, stdout: sink.out },
    );
    assert.equal(res.code, 0);
    assert.match(sink.text(), /Renamed profile "z\.ai" to "zed"/);
    const listSink = collectStdout();
    await runProfile({ kind: 'profile-list' }, { homeDir: home.path, stdout: listSink.out });
    assert.match(listSink.text(), /\* zed/);
    assert.doesNotMatch(
      listSink.text(),
      /^[* ] z\.ai\t/m,
      'the old profile name must be gone from the listing',
    );
  } finally {
    await home.cleanup();
  }
});

test('runProfile: rename to an existing name exits 1', async () => {
  const home = await tempHome();
  try {
    await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai' },
      { homeDir: home.path, stdout: () => {} },
    );
    await runProfile(
      { kind: 'profile-add', name: 'openrouter', preset: 'openrouter' },
      { homeDir: home.path, stdout: () => {} },
    );
    const res = await runProfile(
      { kind: 'profile-rename', from: 'z.ai', to: 'openrouter' },
      { homeDir: home.path, stdout: () => {} },
    );
    assert.equal(res.code, 1);
    assert.match(res.message ?? '', /already exists/);
  } finally {
    await home.cleanup();
  }
});

test('runProfile: add message reflects auto-activation of the first profile only', async () => {
  const home = await tempHome();
  try {
    const first = collectStdout();
    await runProfile(
      { kind: 'profile-add', name: 'z.ai', preset: 'zai' },
      { homeDir: home.path, stdout: first.out },
    );
    assert.match(first.text(), /Created and activated profile "z\.ai"/);
    const second = collectStdout();
    await runProfile(
      { kind: 'profile-add', name: 'openrouter', preset: 'openrouter' },
      { homeDir: home.path, stdout: second.out },
    );
    assert.match(second.text(), /aitm profile use openrouter/);
  } finally {
    await home.cleanup();
  }
});

// ---- runClean ---------------------------------------------------------------

async function tempStateCwd(): Promise<{
  cwd: string;
  stateDir: string;
  cleanup: () => Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'aitm-clean-'));
  const stateDir = join(cwd, '.ai-task-master');
  await mkdir(join(stateDir, 'logs'), { recursive: true });
  await mkdir(join(stateDir, 'memory'), { recursive: true });
  await writeFile(join(stateDir, 'state.json'), '{}\n');
  await writeFile(join(stateDir, 'memory', 'note.md'), 'durable\n');
  return { cwd, stateDir, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

async function exists(path: string): Promise<boolean> {
  return readFile(path, 'utf8').then(
    () => true,
    () => false,
  );
}

test('runClean --force deletes the entire state dir, logs and memory included', async () => {
  const { cwd, stateDir, cleanup } = await tempStateCwd();
  try {
    const out: string[] = [];
    const exit = await runClean(
      { kind: 'clean', force: true },
      { cwd, stdout: (c) => out.push(c) },
    );
    assert.deepEqual(exit, { code: 0 });
    assert.equal(await exists(join(stateDir, 'state.json')), false);
    assert.equal(await exists(join(stateDir, 'memory', 'note.md')), false);
    assert.match(out.join(''), /Task state cleaned/);
  } finally {
    await cleanup();
  }
});

test('runClean without state dir reports nothing to do, exit 0, and never prompts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'aitm-clean-empty-'));
  try {
    const out: string[] = [];
    const exit = await runClean(
      { kind: 'clean', force: false },
      {
        cwd,
        stdout: (c) => out.push(c),
        confirm: async () => {
          throw new Error('must not prompt when there is nothing to delete');
        },
      },
    );
    assert.deepEqual(exit, { code: 0 });
    assert.match(out.join(''), /No task state found/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('runClean prompts without --force; a denied confirm leaves state intact, exit 1', async () => {
  const { cwd, stateDir, cleanup } = await tempStateCwd();
  try {
    const asked: string[] = [];
    const exit = await runClean(
      { kind: 'clean', force: false },
      {
        cwd,
        stdout: () => {},
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      },
    );
    assert.equal(exit.code, 1);
    assert.match(exit.message ?? '', /cancelled/);
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? '', /\.ai-task-master/);
    assert.equal(
      await exists(join(stateDir, 'state.json')),
      true,
      'state survives a denied prompt',
    );
  } finally {
    await cleanup();
  }
});

test('runClean with an approving confirm deletes the state dir', async () => {
  const { cwd, stateDir, cleanup } = await tempStateCwd();
  try {
    const exit = await runClean(
      { kind: 'clean', force: false },
      { cwd, stdout: () => {}, confirm: async () => true },
    );
    assert.deepEqual(exit, { code: 0 });
    assert.equal(await exists(join(stateDir, 'state.json')), false);
  } finally {
    await cleanup();
  }
});

// ---- runResume ------------------------------------------------------------

test('runResume: reuses the persisted goal and criteria instead of retyping them', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedStartState(repo.path);
    await writeFile(join(repo.path, '.ai-task-master', 'goal.txt'), 'add jwt auth\n');
    await writeFile(join(repo.path, '.ai-task-master', 'criteria.txt'), 'tests pass\n');
    let captured: RunLoopInput | null = null;
    const result = await runResume(
      { kind: 'resume' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, result.message);
    assert.equal(captured?.goal, 'add jwt auth');
    assert.equal(captured?.criteria, 'tests pass');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runResume: start flags still apply to the resumed run', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedStartState(repo.path);
    await writeFile(join(repo.path, '.ai-task-master', 'goal.txt'), 'add jwt auth\n');
    let captured: RunLoopInput | null = null;
    await runResume(
      { kind: 'resume', maxPrs: 2 },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async (input) => {
          captured = input;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(captured?.resolved.maxPrs, 2);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runResume: a directory that never started says so, and does not run the loop', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    let loopCalls = 0;
    const result = await runResume(
      { kind: 'resume' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => {
          loopCalls++;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /Nothing to resume/);
    assert.match(result.message ?? '', /aitm start/);
    assert.equal(loopCalls, 0);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- isRunComplete + start-on-finished-run --------------------------------

function stateWith(over: Partial<RunState>): RunState {
  return {
    status: 'working',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: 'r1',
    provider: 'openrouter',
    model: 'm',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
    ...over,
  } as RunState;
}

function mergedGroup(id: string): unknown {
  return {
    id,
    title: `group ${id}`,
    tasks: [{ id: `${id}-t1`, text: 't', complexity: 'normal', done: true }],
    dependsOn: [],
    branch: `aitm/${id}`,
    pr: 1,
    status: 'merged',
    stage: 'merged',
  };
}

test('isRunComplete: success status, or every group merged, is complete — nothing else', () => {
  assert.equal(isRunComplete(stateWith({ status: 'success' })), true);
  assert.equal(
    isRunComplete(stateWith({ prGroups: [mergedGroup('g1'), mergedGroup('g2')] as never })),
    true,
  );
  // A partly-merged run is NOT complete.
  assert.equal(
    isRunComplete(
      stateWith({
        prGroups: [
          mergedGroup('g1'),
          { ...(mergedGroup('g2') as object), status: 'pending', stage: 'pending' },
        ] as never,
      }),
    ),
    false,
  );
  // An empty plan must not read as "all merged" via a vacuous every().
  assert.equal(isRunComplete(stateWith({ prGroups: [] })), false);
  // A blocked run is resumable, not complete.
  assert.equal(isRunComplete(stateWith({ status: 'blocked' })), false);
});

test('runStart: a finished run in the directory is superseded — the new goal is planned fresh', async () => {
  // The reported bug: re-running `aitm start "<new goal>"` where a prior run already merged every
  // group resumed that completed run (0 calls, new goal never planned). It must start fresh instead.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedStartState(repo.path, { prGroups: [mergedGroup('old')] });
    await writeFile(join(repo.path, '.ai-task-master', 'goal.txt'), 'the old finished goal\n');
    let out = '';
    let plannerGoal: string | undefined;
    const result = await runStart(
      { kind: 'start', goal: 'a brand new goal' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        modelBanner: async () => '',
        stdout: (chunk) => {
          out += chunk;
        },
        runPlanner: async (input) => {
          plannerGoal = input.goal;
          return { kind: 'blocked', reason: 'stub — planning reached with the new goal' };
        },
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.match(out, /starting a new run for: a brand new goal/i, 'the supersede notice printed');
    assert.equal(
      plannerGoal,
      'a brand new goal',
      'the planner ran on the NEW goal, not the old one',
    );
    // The fresh init rewrote goal.txt to the new goal.
    const goalTxt = await readFile(join(repo.path, '.ai-task-master', 'goal.txt'), 'utf8');
    assert.match(goalTxt, /a brand new goal/);
    assert.ok(result.code === 0 || result.code === 1); // planner stub blocks; the point is it PLANNED
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runResume: a completed run reports "already complete" and does not run the loop', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    await seedStartState(repo.path, { prGroups: [mergedGroup('g1')] });
    await writeFile(join(repo.path, '.ai-task-master', 'goal.txt'), 'a finished goal\n');
    let loopCalls = 0;
    const result = await runResume(
      { kind: 'resume' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => {
          loopCalls++;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 0, 'a finished run is not an error');
    assert.match(result.message ?? '', /already complete/i);
    assert.equal(loopCalls, 0, 'the loop never ran');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('runResume: an unreadable state dir reports the real failure, not "nothing to resume"', async () => {
  // Swallowing every read error would report "nothing to resume" for a run that exists and cannot
  // be read — and would make this error branch unreachable. Only ENOENT means never-started.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  try {
    const dir = join(repo.path, '.ai-task-master');
    await mkdir(dir, { recursive: true });
    // A directory where goal.txt should be: readFile fails with EISDIR, not ENOENT.
    await mkdir(join(dir, 'goal.txt'), { recursive: true });
    let loopCalls = 0;
    const result = await runResume(
      { kind: 'resume' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        resolveStyle: okStyle(),
        runLoop: async () => {
          loopCalls++;
          return { kind: 'success', outcomes: [] };
        },
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /Failed to read the persisted goal/);
    assert.doesNotMatch(result.message ?? '', /Nothing to resume/);
    assert.equal(loopCalls, 0);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- runMcpLogin ------------------------------------------------------------

test('runMcpLogin: drives the injected performOAuth seam and prints the config snippet', async () => {
  let receivedInput: unknown;
  const ctx: McpLoginCtx = {
    performOAuth: async (input) => {
      receivedInput = input;
      return {
        name: 'my-server',
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer tok-123' },
      };
    },
  };
  let out = '';
  ctx.stdout = (chunk) => {
    out += chunk;
  };

  const result = await runMcpLogin(
    { kind: 'mcp-login', serverUrl: 'https://mcp.example.com' },
    ctx,
  );

  assert.equal(result.code, 0);
  assert.deepEqual(receivedInput, { serverUrl: 'https://mcp.example.com' });
  assert.match(out, /OAuth authentication successful/);
  assert.match(out, /"my-server"/);
  assert.match(out, /"Authorization": "Bearer tok-123"/);
});

test('runMcpLogin: forwards callbackUrl and timeout overrides to the seam', async () => {
  let receivedInput: unknown;
  const ctx: McpLoginCtx = {
    performOAuth: async (input) => {
      receivedInput = input;
      return {
        name: 'my-server',
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer tok' },
      };
    },
  };

  await runMcpLogin(
    {
      kind: 'mcp-login',
      serverUrl: 'https://mcp.example.com',
      callbackUrl: 'http://127.0.0.1:9999/callback',
      timeout: 5000,
    },
    ctx,
  );

  assert.deepEqual(receivedInput, {
    serverUrl: 'https://mcp.example.com',
    callbackUrl: 'http://127.0.0.1:9999/callback',
    timeout: 5000,
  });
});

test('runMcpLogin: a rejecting performOAuth seam → exit 1 carrying the error message', async () => {
  const ctx: McpLoginCtx = {
    performOAuth: async () => {
      throw new Error('state mismatch');
    },
  };

  const result = await runMcpLogin(
    { kind: 'mcp-login', serverUrl: 'https://mcp.example.com' },
    ctx,
  );

  assert.equal(result.code, 1);
  assert.match(result.message ?? '', /state mismatch/);
});

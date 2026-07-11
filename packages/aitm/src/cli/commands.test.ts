import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempRepo } from '../testing/temp-repo.ts';
import type {
  CommandExit,
  RunLoopInput,
  RunMergeFlowInput,
  RunPlannerInput,
  StartCtx,
} from './commands.ts';
import {
  autoMergeNotice,
  runConfig,
  runMergePr,
  runProfile,
  runStart,
  usageSummaryLine,
} from './commands.ts';

const FAKE_KEY = 'sk-or-fake-test-key';

async function tempHome(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-home-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

function okAuth(): StartCtx['authStatus'] {
  return async () => ({ ok: true, scopes: ['repo'] });
}

function badAuth(): StartCtx['authStatus'] {
  return async () => ({ ok: false, scopes: [] });
}

const STUB_DIGEST = '# Coding Style\n\nstub digest\n';

// Stub the coding-style seam so unit tests never make a real LLM call via the default distiller.
function okStyle(): StartCtx['resolveStyle'] {
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

test('autoMergeNotice: full warning when on, null when off', () => {
  const on = autoMergeNotice(true);
  assert.ok(on, 'notice present when auto-merge on');
  assert.match(on, /auto-merge is ON/);
  // The core surprise: merges run via gh, outside the tool boundary, bypassing git-guard.
  assert.match(on, /gh/);
  assert.match(on, /git-guard/);
  // Both the per-run flag and the persistent disable are offered.
  assert.match(on, /--no-automerge/);
  assert.match(on, /config set autoMerge false/);
  assert.equal(autoMergeNotice(false), null);
});

test('usageSummaryLine: renders overall tokens + per-role breakdown + cost, or "cost unknown" (issue #114)', () => {
  const line = usageSummaryLine({
    perRole: {
      planner: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 0,
        calls: 1,
        costUsd: 0.001,
      },
      worker: {
        inputTokens: 500,
        outputTokens: 80,
        cachedInputTokens: 50,
        calls: 4,
        costUsd: 0.009,
      },
    },
    overall: {
      inputTokens: 600,
      outputTokens: 100,
      cachedInputTokens: 50,
      calls: 5,
      costUsd: 0.01,
    },
  });
  assert.match(line, /^Usage: 5 calls, 600 in \/ 100 out tokens \(50 cached\), \$0\.0100/);
  assert.match(line, /planner 100in\/20out/);
  assert.match(line, /worker 500in\/80out/);
  assert.ok(line.endsWith('\n'), 'exactly one line');

  // Null overall cost (any pricing unavailable) renders "cost unknown".
  const unknown = usageSummaryLine({
    perRole: {},
    overall: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, calls: 1, costUsd: null },
  });
  assert.match(unknown, /cost unknown/);
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

test('runStart: missing CLAUDE.md and AGENTS.md → exit 1', async () => {
  const repo = await makeTempRepo({ withClaudeMd: false });
  const home = await tempHome();
  try {
    const result = await runStart(
      { kind: 'start', goal: 'g' },
      {
        cwd: repo.path,
        homeDir: home.path,
        env: { OPENROUTER_API_KEY: FAKE_KEY },
        authStatus: okAuth(),
        runLoop: async () => ({ kind: 'success', outcomes: [] }),
      },
    );
    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /CLAUDE\.md|AGENTS\.md/);
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
    assert.equal(captured?.styleDigest, cached, 'cached digest reused and threaded to runLoop');
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

async function seedState(
  repoPath: string,
  patch: { currentPr?: number | null; stylePath?: string | null } = {},
): Promise<void> {
  const dir = join(repoPath, '.ai-task-master');
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    status: 'awaiting-pr',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: 'currentPr' in patch ? patch.currentPr : 42,
    runId: 'run-test',
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
      { kind: 'config-list', scope: 'global' },
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
      { kind: 'config-list', scope: 'global' },
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

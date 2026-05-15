import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempRepo } from '../testing/temp-repo.ts';
import type { CommandExit, RunLoopInput, RunMergeFlowInput, StartCtx } from './commands.ts';
import { runConfig, runMergePr, runStart } from './commands.ts';

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

// End-to-end: CI-fix loop (fail→fix→green→merge) + failure modes.
//
// Mirror of start-flow.test.ts structure. Four tests against runMergePr with an injected
// runMergeFlow that drives runTakeOverFlow directly. GitHub is fully stubbed — no real gh
// CLI calls. PrContextStore is real for test 1 (log-download assertion). runCmd is stubbed
// for git fetch/rebase/push (no real remote in temp repos).
//
// Test 1 — fail→fix→green→merge:
//   waitForChecks fails on call 1, succeeds on call 2. getFailedCiLogs returns one entry.
//   runWorkerOverride returns { kind: 'ok' }. Asserts exit 0, Worker called, CI polled
//   twice, logs downloaded to .ai-task-master/debugging/pr/1/ci/.
//
// Test 2 — cap-exhausted → exit 1:
//   maxIterations=1, CI always fails. Loop exhausts → final check still failure →
//   { kind: 'blocked' } → runMergeFlow maps to blocked → exit 1.
//
// Test 3 — MergeConflict → exit 1:
//   CI success, no threads, mergePr throws MergeConflict → propagates through
//   runTakeOverFlow → runMergeFlow → caught by runMergePr outer try-catch → exit 1.
//
// Test 4 — cancel → exit 2:
//   Pre-aborted AbortSignal. runTakeOverFlow bails on iteration 0 → { kind: 'cancelled' }
//   → runMergeFlow returns { kind: 'cancelled' } → mapResultToExit → exit 2.
//
// Test 5 — WorkLoop/autoMerge, real remote: fix lands on origin before the PR merges:
//   Real bare `origin` remote. runCiFix pushes a real commit to it; mergePr's stub captures the
//   remote branch's HEAD sha at the moment it fires. Asserts that sha already equals the local
//   fix commit — the push happened before, not after, the merge (docs/plans/.../03-*.md).
//
// Test 6 — WorkLoop/autoMerge: unfixable PR never merges red, stays blocked across a resumed WorkLoop:
//   waitForChecks always fails; runCiFix always lands a (real, useless) commit. With
//   maxCiFixAttempts=2 the group blocks after exactly 2 fix passes — mergePr is never called. A
//   second, freshly-constructed WorkLoop against the SAME on-disk StateStore (after the production
//   normalizeResumeStatus pass) must not spend any further budget or merge — the human-needed block
//   survives the "process restart".

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import type { RunMergeFlowInput } from '../../src/cli/commands.ts';
import { runMergePr } from '../../src/cli/commands.ts';
import { MergeConflict } from '../../src/github/errors.ts';
import type { CiResult, RunCmd } from '../../src/github/github-client.ts';
import { defaultRunCmd } from '../../src/github/github-client.ts';
import type { ReviewThread } from '../../src/github/schema.ts';
import { normalizeResumeStatus } from '../../src/loop/resume-normalize.ts';
import { localEditTools } from '../../src/loop/run-loop-adapter.ts';
import type { TakeOverResult } from '../../src/loop/take-over-flow.ts';
import { runTakeOverFlow } from '../../src/loop/take-over-flow.ts';
import type {
  WorkLoopGithub,
  WorkLoopOrchestrator,
  WorkLoopResult,
  WorkLoopState,
} from '../../src/loop/work-loop.ts';
import { WorkLoop } from '../../src/loop/work-loop.ts';
import { PlanGraph } from '../../src/plan/plan-graph.ts';
import { PrContextStore } from '../../src/state/pr-context-store.ts';
import type { PrGroup, RunState } from '../../src/state/schema.ts';
import { RunStateSchema } from '../../src/state/schema.ts';
import { StateStore } from '../../src/state/state-store.ts';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';
import { githubThreadTool } from '../../src/tools/github-thread-tool.ts';
import { InPlaceCheckout } from '../../src/workspace/in-place-checkout.ts';

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Convert runTakeOverFlow's three-variant result to the WorkLoopResult runMergeFlow returns. */
function toWorkLoopResult(result: TakeOverResult, pr: number): WorkLoopResult {
  if (result.kind === 'merged') {
    return {
      kind: 'success',
      outcomes: [{ groupId: `takeover-${pr}`, status: 'merged', pr }],
    };
  }
  if (result.kind === 'cancelled') {
    return { kind: 'cancelled', outcomes: [] };
  }
  return {
    kind: 'blocked',
    reason: result.reason,
    outcomes: [{ groupId: `takeover-${pr}`, status: 'blocked', reason: result.reason }],
  };
}

/**
 * Stub runCmd: passes all git commands through to real execa EXCEPT fetch/rebase/push,
 * which require a real remote. Those return success unconditionally so tests run against
 * local temp repos that have no origin.
 */
const stubNetworkRunCmd: RunCmd = async (cmd, args, opts) => {
  if (cmd === 'git' && args[0] !== undefined && ['fetch', 'rebase', 'push'].includes(args[0])) {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  return defaultRunCmd(cmd, args, opts);
};

/** Threads stub — no unresolved threads in any test. */
const noThreads = async (): Promise<ReviewThread[]> => [];

/** Build reviewer tools: worker tools + a no-op github thread tool. */
function makeReviewerTools(cwd: string) {
  const workerTools = localEditTools(cwd);
  return {
    ...workerTools,
    github: githubThreadTool({
      github: { replyToThread: async () => {}, resolveThread: async () => {} },
    }),
  };
}

// ── Test 1: fail → fix → green → merge ───────────────────────────────────────

test('ci-fix-loop: CI fails once, Worker fixes, re-poll succeeds, PR merges → exit 0 + logs downloaded', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const stateDir = join(repo.path, '.ai-task-master');
    const prContext = new PrContextStore(stateDir);
    const workerTools = localEditTools(repo.path);
    const reviewerTools = makeReviewerTools(repo.path);

    let waitForChecksCalls = 0;
    let workerCalled = false;
    let mergeCalled = false;

    const result = await runMergePr(
      { kind: 'merge-pr', pr: 1, resume: false },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        resolveStyle: async () => '# CLAUDE.md\n',
        runMergeFlow: async (input: RunMergeFlowInput): Promise<WorkLoopResult> => {
          const flowResult = await runTakeOverFlow({
            pr: 1,
            checkoutPath: repo.path,
            baseBranch: 'main',
            github: {
              waitForChecks: async (): Promise<CiResult> => {
                waitForChecksCalls++;
                if (waitForChecksCalls === 1) {
                  return {
                    state: 'failure' as const,
                    failedChecks: [{ name: 'test / lint', status: 'failure' as const }],
                  };
                }
                return { state: 'success' as const, failedChecks: [] };
              },
              listUnresolvedThreads: noThreads,
              mergePr: async () => {
                mergeCalled = true;
              },
              replyToThread: async () => {},
              resolveThread: async () => {},
              getFailedCiLogs: async () => [
                { check: 'test / lint', logs: 'Error: lint failed\n  at index.ts:5' },
              ],
            },
            subagents: {
              reviewerModel: input.credentials.modelFor('reviewer'),
              reviewerTools,
              workerModel: input.credentials.modelFor('worker'),
              workerTools,
              styleContents: '# CLAUDE.md\n',
              runWorkerOverride: async () => {
                workerCalled = true;
                return {
                  kind: 'ok' as const,
                  delivery: {
                    branch: 'main',
                    draftCommitMessage: 'fix: lint error',
                    changes: [{ path: 'index.ts', kind: 'modify' as const, summary: 'fix lint' }],
                    progressEntries: ['- fixed lint error'],
                  },
                };
              },
            },
            prContext,
            mergeMethod: 'squash',
            maxIterations: input.maxIterations ?? 5,
            cooldownMs: 0,
            runCmd: stubNetworkRunCmd,
          });
          return toWorkLoopResult(flowResult, 1);
        },
      },
    );

    assert.equal(result.code, 0, `unexpected exit code: ${result.message ?? ''}`);
    assert.ok(workerCalled, 'Worker CI-fix must be called when CI fails');
    assert.ok(mergeCalled, 'mergePr must be called after CI passes');
    // runTakeOverFlow polls CI in-loop (fail on 1, success on 2 → break) then does a final
    // check before merging (call 3): total 3 polls.
    assert.equal(waitForChecksCalls, 3, 'CI must be polled 3 times (fail, pass, final check)');

    // CI logs must have been downloaded under .ai-task-master/debugging/pr/1/ci/
    const ciDir = join(stateDir, 'debugging', 'pr', '1', 'ci');
    const ciFiles = await readdir(ciDir);
    assert.ok(
      ciFiles.some((f) => f.startsWith('failed_')),
      `expected a failed_*.txt log file in ${ciDir}, got: ${ciFiles.join(', ')}`,
    );
    assert.ok(
      ciFiles.includes('summary.txt'),
      `expected summary.txt in ${ciDir}, got: ${ciFiles.join(', ')}`,
    );
  } finally {
    await repo.cleanup();
  }
});

// ── Test 2: cap-exhausted → exit 1 ───────────────────────────────────────────

test('ci-fix-loop: maxIterations=1 exhausted with always-failing CI → exit 1', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const workerTools = localEditTools(repo.path);
    const reviewerTools = makeReviewerTools(repo.path);

    const result = await runMergePr(
      { kind: 'merge-pr', pr: 2, resume: false, maxIterations: 1 },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        resolveStyle: async () => '# CLAUDE.md\n',
        runMergeFlow: async (input: RunMergeFlowInput): Promise<WorkLoopResult> => {
          const flowResult = await runTakeOverFlow({
            pr: 2,
            checkoutPath: repo.path,
            baseBranch: 'main',
            github: {
              waitForChecks: async (): Promise<CiResult> => ({
                state: 'failure' as const,
                failedChecks: [{ name: 'build', status: 'failure' as const }],
              }),
              listUnresolvedThreads: noThreads,
              mergePr: async () => {},
              replyToThread: async () => {},
              resolveThread: async () => {},
              getFailedCiLogs: async () => [],
            },
            subagents: {
              reviewerModel: input.credentials.modelFor('reviewer'),
              reviewerTools,
              workerModel: input.credentials.modelFor('worker'),
              workerTools,
              styleContents: '# CLAUDE.md\n',
              runWorkerOverride: async () => ({
                kind: 'ok' as const,
                delivery: {
                  branch: 'main',
                  draftCommitMessage: 'fix: ci attempt',
                  changes: [],
                  progressEntries: [],
                },
              }),
            },
            mergeMethod: 'squash',
            // Thread maxIterations from --max-iterations so the flag contract is tested.
            maxIterations: input.maxIterations ?? 1,
            cooldownMs: 0,
            runCmd: stubNetworkRunCmd,
          });
          return toWorkLoopResult(flowResult, 2);
        },
      },
    );

    assert.equal(result.code, 1, `expected exit 1 for cap-exhausted, got ${result.code}`);
    assert.match(
      result.message ?? '',
      /iteration/i,
      `expected iteration-cap message, got: ${result.message ?? ''}`,
    );
  } finally {
    await repo.cleanup();
  }
});

// ── Test 3: MergeConflict → exit 1 ───────────────────────────────────────────

test('ci-fix-loop: MergeConflict thrown by mergePr propagates to exit 1', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const workerTools = localEditTools(repo.path);
    const reviewerTools = makeReviewerTools(repo.path);

    const result = await runMergePr(
      { kind: 'merge-pr', pr: 3, resume: false },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        resolveStyle: async () => '# CLAUDE.md\n',
        // runMergeFlow is NOT catching the MergeConflict — let it propagate to runMergePr's
        // outer try-catch, which maps any thrown error to { code: 1 }.
        runMergeFlow: async (input: RunMergeFlowInput): Promise<WorkLoopResult> => {
          const flowResult = await runTakeOverFlow({
            pr: 3,
            checkoutPath: repo.path,
            baseBranch: 'main',
            github: {
              waitForChecks: async (): Promise<CiResult> => ({
                state: 'success' as const,
                failedChecks: [],
              }),
              listUnresolvedThreads: noThreads,
              mergePr: async () => {
                throw new MergeConflict('Merge conflict on PR #3: branch behind base');
              },
              replyToThread: async () => {},
              resolveThread: async () => {},
            },
            subagents: {
              reviewerModel: input.credentials.modelFor('reviewer'),
              reviewerTools,
              workerModel: input.credentials.modelFor('worker'),
              workerTools,
              styleContents: '# CLAUDE.md\n',
            },
            mergeMethod: 'squash',
            maxIterations: 2,
            cooldownMs: 0,
          });
          return toWorkLoopResult(flowResult, 3);
        },
      },
    );

    assert.equal(result.code, 1, `expected exit 1 for MergeConflict, got ${result.code}`);
    assert.match(
      result.message ?? '',
      /[Mm]erge conflict/,
      `expected merge-conflict message, got: ${result.message ?? ''}`,
    );
  } finally {
    await repo.cleanup();
  }
});

// ── Test 4: cancel → exit 2 ──────────────────────────────────────────────────

test('ci-fix-loop: pre-aborted AbortSignal yields exit 2 (cancelled)', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const workerTools = localEditTools(repo.path);
    const reviewerTools = makeReviewerTools(repo.path);

    const ac = new AbortController();
    ac.abort(); // signal already aborted before the flow begins

    const result = await runMergePr(
      { kind: 'merge-pr', pr: 4, resume: false },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        resolveStyle: async () => '# CLAUDE.md\n',
        signal: ac.signal,
        runMergeFlow: async (input: RunMergeFlowInput): Promise<WorkLoopResult> => {
          const flowResult = await runTakeOverFlow({
            pr: 4,
            checkoutPath: repo.path,
            baseBranch: 'main',
            github: {
              waitForChecks: async (): Promise<CiResult> => ({
                state: 'success' as const,
                failedChecks: [],
              }),
              listUnresolvedThreads: noThreads,
              mergePr: async () => {},
              replyToThread: async () => {},
              resolveThread: async () => {},
            },
            subagents: {
              reviewerModel: input.credentials.modelFor('reviewer'),
              reviewerTools,
              workerModel: input.credentials.modelFor('worker'),
              workerTools,
              styleContents: '# CLAUDE.md\n',
            },
            mergeMethod: 'squash',
            maxIterations: 5,
            cooldownMs: 0,
            // Thread signal from ctx.signal so the MergePrCtx.signal contract is tested.
            signal: input.signal,
          });
          return toWorkLoopResult(flowResult, 4);
        },
      },
    );

    assert.equal(result.code, 2, `expected exit 2 for cancel, got ${result.code}`);
  } finally {
    await repo.cleanup();
  }
});

// ── Tests 5-6: WorkLoop/autoMerge, real git + real StateStore ───────────────────────────────
//
// Tests 1-4 drive runTakeOverFlow (the `merge-pr` take-over loop). These drive WorkLoop directly
// (the `aitm start --auto-merge` path — loop/work-loop.ts's autoMergeFlow / driveStages), the same
// pattern as concurrent-groups.test.ts and resume-flow.test.ts: real git operations, a real
// StateStore, GitHub/orchestrator ports stubbed structurally (no real gh, no real AI SDK call).

function baseWorkLoopState(): RunState {
  return RunStateSchema.parse({
    status: 'working',
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: null,
    runId: '01HFAKERUNID0000000000002',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    options: {
      autoMerge: true,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
  });
}

function ciFixGroup(id: string, branch: string): PrGroup {
  return {
    id,
    title: `work for ${id}`,
    tasks: [{ id: `${id}-t1`, text: `implement ${id}`, complexity: 'normal', done: false }],
    dependsOn: [],
    branch,
    pr: null,
    status: 'pending',
    stage: 'pending',
  };
}

/** Bare `origin` remote seeded with the repo's default branch — for real-push assertions. */
async function withOrigin(
  repoPath: string,
  defaultBranch: string,
): Promise<{ remotePath: string; cleanup: () => Promise<void> }> {
  const remotePath = await mkdtemp(join(tmpdir(), 'aitm-origin-'));
  await execa('git', ['init', '--bare', `--initial-branch=${defaultBranch}`, remotePath]);
  await execa('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath });
  await execa('git', ['push', 'origin', defaultBranch], { cwd: repoPath });
  return { remotePath, cleanup: () => rm(remotePath, { recursive: true, force: true }) };
}

/** HEAD sha the bare remote holds for `branch`, or null if the branch doesn't exist there yet. */
async function remoteHeadSha(remotePath: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['rev-parse', branch], { cwd: remotePath });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function localHeadSha(repoPath: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
  return stdout.trim();
}

test('ci-fix-loop (WorkLoop/autoMerge): CI fix reaches the real remote before the PR merges', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  let origin: { remotePath: string; cleanup: () => Promise<void> } | undefined;
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const { stdout: rawBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo.path,
    });
    const defaultBranch = rawBranch.trim();
    origin = await withOrigin(repo.path, defaultBranch);

    const stateDir = join(repo.path, '.ai-task-master');
    const stateStore = new StateStore(stateDir);
    const groupBranch = 'aitm/ci-fix-remote';
    const grp = ciFixGroup('ci-fix-remote', groupBranch);
    await stateStore.init({ ...baseWorkLoopState(), prGroups: [grp] });

    let liveGroups: readonly PrGroup[] = [grp];
    const graph = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };
    const state: WorkLoopState = {
      update: async (mutator) => {
        const next = await stateStore.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
    };
    const home = new InPlaceCheckout(repo.path);

    let waitForChecksCalls = 0;
    let runCiFixCalls = 0;
    const mergeCalls: number[] = [];
    // Remote branch HEAD sha captured at the instant each mergePr fires — proves the fix push
    // happened BEFORE the merge, not after.
    const remoteShaAtMerge: (string | null)[] = [];

    const orchestrator: WorkLoopOrchestrator = {
      runWorker: async ({ checkout }) => {
        await writeFile(join(checkout.path, 'feature.ts'), 'export const feature = true;\n');
        await execa('git', ['add', 'feature.ts'], { cwd: checkout.path });
        await execa('git', ['commit', '-m', 'feat: add feature'], { cwd: checkout.path });
        return {
          kind: 'ok',
          delivery: {
            branch: checkout.branch,
            draftCommitMessage: 'feat: add feature',
            changes: [{ path: 'feature.ts', kind: 'create', summary: 'adds feature' }],
            progressEntries: ['- added feature.ts'],
          },
        };
      },
      finalizeCommit: async (_group, _delivery, checkoutPath) => {
        const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath });
        return stdout.trim();
      },
      // Mirrors production (run-loop-adapter.ts openPr): push the branch to origin before
      // "opening" the PR — gh can't open a PR for a branch the remote doesn't have yet.
      openPr: async (_group, delivery, baseBranch) => {
        await execa('git', ['push', '-u', 'origin', delivery.branch], { cwd: repo.path });
        return {
          number: 1,
          state: 'OPEN',
          url: 'https://github.com/example/repo/pull/1',
          headRefName: delivery.branch,
          baseRefName: baseBranch,
        };
      },
      // Mirrors the shared ci-fix session (loop/ci-fix.ts runFixSession): a real fix commit,
      // rebased-and-pushed to the remote as part of this call — before WorkLoop re-polls CI.
      runCiFix: async ({ checkout }) => {
        runCiFixCalls++;
        await writeFile(join(checkout.path, 'fix.ts'), 'export const fixed = true;\n');
        await execa('git', ['add', 'fix.ts'], { cwd: checkout.path });
        await execa('git', ['commit', '-m', 'fix: lint error'], { cwd: checkout.path });
        await execa('git', ['push', 'origin', checkout.branch], { cwd: checkout.path });
        return { kind: 'ok' };
      },
      addressReviews: async () => ({ kind: 'ok' }),
    };

    const github: WorkLoopGithub = {
      defaultBranch: async () => defaultBranch,
      waitForChecks: async () => {
        waitForChecksCalls++;
        // The first poll (right after pr-open) fails; every poll after the fix lands succeeds.
        return waitForChecksCalls === 1
          ? {
              state: 'failure' as const,
              failedChecks: [{ name: 'test', status: 'failure' as const }],
            }
          : { state: 'success' as const, failedChecks: [] };
      },
      listUnresolvedThreads: async () => [],
      mergePr: async (pr) => {
        mergeCalls.push(pr);
        // biome-ignore lint/style/noNonNullAssertion: origin is assigned above before the loop runs
        remoteShaAtMerge.push(await remoteHeadSha(origin!.remotePath, groupBranch));
      },
    };

    const loop = new WorkLoop({
      orchestrator,
      github,
      state,
      home,
      graph,
      concurrency: 1,
      autoMerge: true,
      maxSessions: null,
      sleep: async () => {}, // skip the real post-CI review grace
    });

    const result = await loop.run();
    assert.equal(result.kind, 'success', `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(runCiFixCalls, 1, 'the fix session runs exactly once on the red PR');
    assert.deepEqual(mergeCalls, [1], 'PR merges exactly once, after CI goes green');

    const localSha = await localHeadSha(repo.path);
    assert.equal(
      remoteShaAtMerge[0],
      localSha,
      'the remote branch must already carry the fix commit at the moment mergePr fires',
    );

    const remoteFix = await execa('git', ['show', `${groupBranch}:fix.ts`], {
      cwd: origin.remotePath,
    });
    assert.ok(
      remoteFix.stdout.includes('fixed'),
      `fix.ts must be present on the remote branch, got: ${remoteFix.stdout}`,
    );
  } finally {
    await origin?.cleanup();
    await repo.cleanup();
  }
});

test('ci-fix-loop (WorkLoop/autoMerge): an unfixable red PR never merges and stays durably blocked across a resumed WorkLoop', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const { stdout: rawBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo.path,
    });
    const defaultBranch = rawBranch.trim();

    const stateDir = join(repo.path, '.ai-task-master');
    const stateStore = new StateStore(stateDir);
    const groupBranch = 'aitm/unfixable';
    const grp = ciFixGroup('unfixable', groupBranch);
    await stateStore.init({ ...baseWorkLoopState(), prGroups: [grp] });

    const home = new InPlaceCheckout(repo.path);

    let runCiFixCalls = 0;
    const mergeCalls: number[] = [];

    // Shared across both WorkLoop constructions below: the fix session lands a real commit every
    // call, but CI never turns green — an unfixable failure (flaky infra, missing secret, ...).
    const orchestrator: WorkLoopOrchestrator = {
      runWorker: async ({ checkout }) => {
        await writeFile(join(checkout.path, 'feature.ts'), 'export const feature = true;\n');
        await execa('git', ['add', 'feature.ts'], { cwd: checkout.path });
        await execa('git', ['commit', '-m', 'feat: add feature'], { cwd: checkout.path });
        return {
          kind: 'ok',
          delivery: {
            branch: checkout.branch,
            draftCommitMessage: 'feat: add feature',
            changes: [{ path: 'feature.ts', kind: 'create', summary: 'adds feature' }],
            progressEntries: ['- added feature.ts'],
          },
        };
      },
      finalizeCommit: async (_group, _delivery, checkoutPath) => {
        const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath });
        return stdout.trim();
      },
      openPr: async (_group, delivery, baseBranch) => ({
        number: 1,
        state: 'OPEN',
        url: 'https://github.com/example/repo/pull/1',
        headRefName: delivery.branch,
        baseRefName: baseBranch,
      }),
      runCiFix: async ({ checkout }) => {
        runCiFixCalls++;
        const file = `attempt-${runCiFixCalls}.ts`;
        await writeFile(join(checkout.path, file), 'export const x = 1;\n');
        await execa('git', ['add', file], { cwd: checkout.path });
        await execa('git', ['commit', '-m', `fix: attempt ${runCiFixCalls}`], {
          cwd: checkout.path,
        });
        return { kind: 'ok' }; // a commit lands, but it never actually fixes the flake below
      },
      addressReviews: async () => ({ kind: 'ok' }),
    };

    const github: WorkLoopGithub = {
      defaultBranch: async () => defaultBranch,
      waitForChecks: async () => ({
        state: 'failure' as const,
        failedChecks: [{ name: 'flaky', status: 'failure' as const }],
      }),
      listUnresolvedThreads: async () => [],
      mergePr: async (pr) => {
        mergeCalls.push(pr);
      },
    };

    // ── First run: burn the CI-fix budget, block for a human, never merge ──────────────────
    let liveGroups: readonly PrGroup[] = [grp];
    const graph1 = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };
    const state1: WorkLoopState = {
      update: async (mutator) => {
        const next = await stateStore.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
    };
    const loop1 = new WorkLoop({
      orchestrator,
      github,
      state: state1,
      home,
      graph: graph1,
      concurrency: 1,
      autoMerge: true,
      maxSessions: null,
      maxCiFixAttempts: 2,
      sleep: async () => {},
    });

    const result1 = await loop1.run();
    assert.equal(result1.kind, 'blocked', `expected blocked, got: ${JSON.stringify(result1)}`);
    assert.equal(runCiFixCalls, 2, 'the fix session runs exactly maxCiFixAttempts times');
    assert.deepEqual(mergeCalls, [], 'a still-red PR must never be merged');

    const afterFirstRun = await stateStore.read();
    const persisted1 = afterFirstRun.prGroups.find((g) => g.id === 'unfixable');
    assert.ok(persisted1, 'group must exist in persisted state');
    assert.equal(persisted1?.status, 'blocked');
    assert.equal(persisted1?.humanNeeded, true, 'budget exhaustion must flag human-needed');
    assert.equal(persisted1?.ciFixAttempts, 3);

    // ── Simulate a process restart: apply the SAME resume normalization runStart applies ────
    await stateStore.update((s) => ({ ...s, prGroups: normalizeResumeStatus(s.prGroups) }));

    // ── Second run: a FRESH WorkLoop against the same on-disk state must not re-attempt ─────
    const afterNormalize = await stateStore.read();
    let liveGroups2: readonly PrGroup[] = afterNormalize.prGroups;
    const graph2 = {
      ready: () => new PlanGraph([...liveGroups2]).ready(),
      isComplete: () => new PlanGraph([...liveGroups2]).isComplete(),
    };
    assert.equal(graph2.ready().length, 0, 'a human-needed group must never be rescheduled');
    assert.equal(graph2.isComplete(), true, 'the blocked group is terminal for the graph');

    const state2: WorkLoopState = {
      update: async (mutator) => {
        const next = await stateStore.update(mutator);
        liveGroups2 = next.prGroups;
        return next;
      },
    };
    const loop2 = new WorkLoop({
      orchestrator,
      github,
      state: state2,
      home,
      graph: graph2,
      concurrency: 1,
      autoMerge: true,
      maxSessions: null,
      maxCiFixAttempts: 2,
      sleep: async () => {},
    });

    const result2 = await loop2.run();
    // Nothing is ready to schedule, so this fresh instance's own outcome list stays empty — that
    // reads as a no-op 'success', not a claim the group itself succeeded. The group's real status
    // is asserted from the persisted StateStore below, which is what an operator actually inspects.
    assert.equal(result2.kind, 'success', `expected a no-op run, got: ${JSON.stringify(result2)}`);
    assert.equal(runCiFixCalls, 2, 'resume must not spend any further CI-fix budget');
    assert.deepEqual(mergeCalls, [], 'resume must never merge the still-blocked PR');

    const afterSecondRun = await stateStore.read();
    const persisted2 = afterSecondRun.prGroups.find((g) => g.id === 'unfixable');
    assert.equal(persisted2?.status, 'blocked', 'group must remain durably blocked');
    assert.equal(persisted2?.humanNeeded, true);
    assert.equal(persisted2?.ciFixAttempts, 3, 'the durable counter must not advance further');
  } finally {
    await repo.cleanup();
  }
});

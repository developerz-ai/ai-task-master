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

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import type { RunMergeFlowInput } from '../../src/cli/commands.ts';
import { runMergePr } from '../../src/cli/commands.ts';
import { MergeConflict } from '../../src/github/errors.ts';
import type { CiResult, RunCmd } from '../../src/github/github-client.ts';
import { defaultRunCmd } from '../../src/github/github-client.ts';
import type { ReviewThread } from '../../src/github/schema.ts';
import { localEditTools } from '../../src/loop/run-loop-adapter.ts';
import type { TakeOverResult } from '../../src/loop/take-over-flow.ts';
import { runTakeOverFlow } from '../../src/loop/take-over-flow.ts';
import type { WorkLoopResult } from '../../src/loop/work-loop.ts';
import { PrContextStore } from '../../src/state/pr-context-store.ts';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';
import { githubThreadTool } from '../../src/tools/github-thread-tool.ts';

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

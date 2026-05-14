// Integration: resume after `blocked` exit, --no-automerge path.
//
// Test 1 — blocked → resume:
//   - First runStart: stubbed runLoop returns blocked immediately (no git work).
//   - State preserved (state.json exists). Second runStart skips re-init (resume detection).
//   - runId identical across both runs. Exactly one aitm/* branch created (no duplicates).
//
// Test 2 — --no-automerge → merge-pr pickup:
//   - runStart with autoMerge:false exits 0 with "merge-pr" instruction.
//   - currentPr is persisted to state so runMergePr can pick up without --pr flag.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { execa } from 'execa';
import type { RunLoopInput } from '../../src/cli/commands.ts';
import { runMergePr, runStart } from '../../src/cli/commands.ts';
import type { PullRequest } from '../../src/github/schema.ts';
import type { WorkLoopOrchestrator, WorkLoopResult } from '../../src/loop/work-loop.ts';
import { WorkLoop } from '../../src/loop/work-loop.ts';
import { Orchestrator } from '../../src/orchestrator/orchestrator.ts';
import { PlanGraph } from '../../src/plan/plan-graph.ts';
import type { PrGroup, RunState } from '../../src/state/schema.ts';
import { StateStore } from '../../src/state/state-store.ts';
import type { WorkerDelivery } from '../../src/subagents/worker.ts';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';
import { WorktreePool } from '../../src/workspace/worktree-pool.ts';

// ---------------------------------------------------------------------------
// Helpers shared with start-flow.test.ts (copied to keep tests self-contained)
// ---------------------------------------------------------------------------

function makeMockModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'feat: add hello' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: {
          total: 10 as number | undefined,
          noCache: 10 as number | undefined,
          cacheRead: undefined as number | undefined,
          cacheWrite: undefined as number | undefined,
        },
        outputTokens: {
          total: 5 as number | undefined,
          text: 5 as number | undefined,
          reasoning: undefined as number | undefined,
        },
      },
      warnings: [],
    }),
  });
}

/**
 * Builds a runLoop that does real git ops (same structure as start-flow.test.ts).
 * Worker writes hello.ts; Orchestrator.finalizeCommit uses MockLanguageModelV3.
 * GitHubClient is fully stubbed — no real gh calls.
 */
function makeRunLoop(
  mockModel: MockLanguageModelV3,
): (input: RunLoopInput) => Promise<WorkLoopResult> {
  return async (input: RunLoopInput): Promise<WorkLoopResult> => {
    const stateDir = resolvePath(input.cwd, '.ai-task-master');

    const planGroup: PrGroup = {
      id: 'hello',
      title: 'add hello',
      tasks: ['create hello.ts with a simple export'],
      dependsOn: [],
      branch: 'aitm/hello',
      pr: null,
      status: 'pending',
    };

    let liveGroups: readonly PrGroup[] = [planGroup];

    await input.state.update((s) => ({
      ...s,
      status: 'working' as const,
      prGroups: [planGroup],
    }));

    const graph = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };

    const workLoopState = {
      update: async (mutator: (s: RunState) => RunState): Promise<RunState> => {
        const next = await input.state.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
    };

    const { stdout: rawBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: input.cwd,
    });
    const defaultBranch = rawBranch.trim();

    const pool = new WorktreePool(input.cwd, stateDir, input.resolved.concurrency);

    const orchForFinalize = new Orchestrator({
      credentials: { modelFor: () => mockModel },
      agentConfig: input.agentConfig,
      rollingContext: '',
      maxSessions: null,
      github: {
        createPr: async () => {
          throw new Error('createPr must not be called from finalizeCommit');
        },
      },
    });

    const stubOrchestrator: WorkLoopOrchestrator = {
      runWorker: async ({ worktree }) => {
        await writeFile(join(worktree.path, 'hello.ts'), 'export const hello = "hello";\n');
        await execa('git', ['add', 'hello.ts'], { cwd: worktree.path });
        await execa('git', ['commit', '-m', 'wip: add hello'], { cwd: worktree.path });
        const delivery: WorkerDelivery = {
          branch: worktree.branch,
          draftCommitMessage: 'feat: add hello',
          changes: [{ path: 'hello.ts', kind: 'create', summary: 'creates hello export' }],
          progressEntries: ['- created hello.ts'],
        };
        return { kind: 'ok', delivery };
      },
      finalizeCommit: (group, delivery, worktreePath) =>
        orchForFinalize.finalizeCommit(group, delivery, worktreePath),
      openPr: async (group, _delivery, baseBranch): Promise<PullRequest> => ({
        number: 1,
        state: 'OPEN',
        url: 'https://github.com/example/repo/pull/1',
        headRefName: group.branch ?? `aitm/${group.id}`,
        baseRefName: baseBranch,
      }),
      runReviewer: async () => ({ kind: 'ok', resolutions: [] }),
    };

    const github = {
      defaultBranch: async () => defaultBranch,
      waitForChecks: async () => 'success' as const,
      listUnresolvedThreads: async () => [],
      mergePr: async () => {},
    };

    const loop = new WorkLoop({
      orchestrator: stubOrchestrator,
      github,
      state: workLoopState,
      pool,
      graph,
      concurrency: input.resolved.concurrency,
      autoMerge: false,
      maxSessions: null,
    });

    return loop.run();
  };
}

// ---------------------------------------------------------------------------
// Test 1: blocked → resume preserves runId, no duplicate branches
// ---------------------------------------------------------------------------

test('resume-flow: second runStart resumes from state.json after blocked exit', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const commonCtx = {
      cwd: repo.path,
      homeDir: repo.path,
      env: { OPENROUTER_API_KEY: 'test-key-x' },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
    };

    // ── First run: blocked immediately, no git work ──────────────────────
    const result1 = await runStart(
      { kind: 'start', goal: 'add hello' },
      {
        ...commonCtx,
        runLoop: async (): Promise<WorkLoopResult> => ({
          kind: 'blocked',
          reason: 'planner could not parse goal',
          outcomes: [],
        }),
      },
    );

    assert.equal(result1.code, 1, `expected exit 1 for blocked, got ${result1.code}`);
    assert.match(result1.message ?? '', /planner could not parse goal/);

    // State must be preserved (state.json created by runStart before invoking runLoop).
    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    const state1 = await store.read();
    const preservedRunId = state1.runId;
    assert.ok(preservedRunId.length > 0, 'runId must be non-empty after first run');

    // No aitm/* branches should exist yet (blocked before any git work).
    const { stdout: branches1 } = await execa('git', ['branch', '--list', 'aitm/*'], {
      cwd: repo.path,
    });
    assert.equal(branches1.trim(), '', 'no aitm/* branches should exist after blocked first run');

    // ── Second run: resume (state.json exists → no re-init) ─────────────
    const result2 = await runStart(
      { kind: 'start', goal: 'add hello' },
      {
        ...commonCtx,
        runLoop: makeRunLoop(makeMockModel()),
      },
    );

    assert.equal(
      result2.code,
      0,
      `expected exit 0 on resume, got ${result2.code}: ${result2.message ?? ''}`,
    );

    // runId must be identical — state was not re-initialised.
    const state2 = await store.read();
    assert.equal(
      state2.runId,
      preservedRunId,
      `runId changed across resume: ${preservedRunId} → ${state2.runId}`,
    );

    // Exactly one aitm/* branch — no duplicates from retrying the same group.
    const { stdout: branches2 } = await execa('git', ['branch', '--list', 'aitm/*'], {
      cwd: repo.path,
    });
    const branchList = branches2.trim().split('\n').filter(Boolean);
    assert.equal(
      branchList.length,
      1,
      `expected exactly 1 aitm/* branch after resume, got: ${branchList.join(', ')}`,
    );
    assert.ok(
      branchList.some((b) => b.trim() === 'aitm/hello'),
      `expected aitm/hello in branch list, got: ${branchList.join(', ')}`,
    );

    // prGroups[0] must have transitioned to awaiting-pr.
    const grp = state2.prGroups[0];
    assert.ok(grp !== undefined, 'prGroups[0] must exist after resume');
    assert.equal(grp.status, 'awaiting-pr');
    assert.equal(grp.pr, 1);
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 2: --no-automerge exits 0 with awaiting-pr instruction; merge-pr picks up
// ---------------------------------------------------------------------------

test('resume-flow: --no-automerge exits 0 with merge-pr instruction; merge-pr picks up via currentPr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const commonCtx = {
      cwd: repo.path,
      homeDir: repo.path,
      env: { OPENROUTER_API_KEY: 'test-key-x' },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
    };

    // ── runStart with --no-automerge ─────────────────────────────────────
    const result = await runStart(
      { kind: 'start', goal: 'add hello', autoMerge: false },
      {
        ...commonCtx,
        runLoop: makeRunLoop(makeMockModel()),
      },
    );

    assert.equal(
      result.code,
      0,
      `expected exit 0 for awaiting-pr, got ${result.code}: ${result.message ?? ''}`,
    );
    assert.match(
      result.message ?? '',
      /merge-pr/,
      `expected "merge-pr" in exit message, got: ${result.message ?? ''}`,
    );
    assert.match(
      result.message ?? '',
      /1/,
      `expected PR number in exit message, got: ${result.message ?? ''}`,
    );

    // State must have currentPr set so merge-pr can pick up without --pr.
    const stateDir = join(repo.path, '.ai-task-master');
    const store = new StateStore(stateDir);
    const stateAfterStart = await store.read();
    assert.equal(
      stateAfterStart.currentPr,
      1,
      `expected currentPr=1 in state, got: ${String(stateAfterStart.currentPr)}`,
    );

    // ── runMergePr: picks up from state.currentPr (no --pr flag) ─────────
    let capturedPr: number | undefined;
    const mergeResult = await runMergePr(
      { kind: 'merge-pr', resume: true },
      {
        ...commonCtx,
        runMergeFlow: async (input) => {
          capturedPr = input.pr;
          return { kind: 'success', outcomes: [] };
        },
      },
    );

    assert.equal(
      mergeResult.code,
      0,
      `expected merge-pr exit 0, got ${mergeResult.code}: ${mergeResult.message ?? ''}`,
    );
    assert.equal(
      capturedPr,
      1,
      `merge-pr must use currentPr=1 from state, got: ${String(capturedPr)}`,
    );
  } finally {
    await repo.cleanup();
  }
});

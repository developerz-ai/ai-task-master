// End-to-end: plan→work→PR open with the AI SDK mocked only at the model boundary.
//
// - makeTempRepo({ withClaudeMd: true }) seeds a real git repo
// - MockLanguageModelV3 stubs Credentials.modelFor for Orchestrator.finalizeCommit's generateText
// - WorkLoop / PlanGraph / WorktreePool run against real git operations
// - Worker writes files directly (canned), bypassing the AI planner
// - GhClient is stubbed — no real GitHub calls
//
// Assertions:
//   1. prGroups[0].status transitions to awaiting-pr in state.json
//   2. Branch aitm/hello is created in the repo
//   3. hello.ts is written on that branch
//   4. At least one commit with message "feat: add hello" exists on the branch

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { execa } from 'execa';
import type { RunLoopInput } from '../../src/cli/commands.ts';
import { runStart } from '../../src/cli/commands.ts';
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
// Helpers
// ---------------------------------------------------------------------------

/** MockLanguageModelV3 that returns a canned commit-message string. */
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
 * runLoop fixture: wires WorkLoop / PlanGraph / WorktreePool with real git operations.
 * Worker writes hello.ts directly (no Planner AI call). Orchestrator.finalizeCommit
 * runs with the injected MockLanguageModelV3 — the only real AI SDK boundary exercised.
 * GitHubClient is stubbed so no gh binary calls are made.
 */
function makeRunLoop(
  mockModel: MockLanguageModelV3,
): (input: RunLoopInput) => Promise<WorkLoopResult> {
  return async (input: RunLoopInput): Promise<WorkLoopResult> => {
    const stateDir = resolvePath(input.cwd, '.ai-task-master');

    // Hardcode one PR group — bypass the Planner subagent for this integration test.
    const planGroup: PrGroup = {
      id: 'hello',
      title: 'add hello',
      tasks: ['create hello.ts with a simple export'],
      dependsOn: [],
      branch: 'aitm/hello',
      pr: null,
      status: 'pending',
    };

    // Mirror of prGroups kept in sync with every state.update so the graph reads live data.
    let liveGroups: readonly PrGroup[] = [planGroup];

    // Seed state with the plan and transition to 'working'.
    await input.state.update((s) => ({
      ...s,
      status: 'working' as const,
      prGroups: [planGroup],
    }));

    // Live graph: re-constructs PlanGraph on each call so status changes are visible.
    const graph = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };

    // State proxy: keeps liveGroups in sync after each persisted update.
    const workLoopState = {
      update: async (mutator: (s: RunState) => RunState): Promise<RunState> => {
        const next = await input.state.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
    };

    // Detect the real default branch (could be 'main' or 'master' depending on git config).
    const { stdout: rawBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: input.cwd,
    });
    const defaultBranch = rawBranch.trim();

    const pool = new WorktreePool(input.cwd, stateDir, input.resolved.concurrency);

    // Orchestrator instance used only for finalizeCommit — exercises generateText at the
    // model boundary with MockLanguageModelV3.
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
      /** Writes hello.ts and creates an initial commit — simulates the Worker subagent. */
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
      /** Real Orchestrator.finalizeCommit — calls generateText with the mock model. */
      finalizeCommit: (group, delivery, worktreePath) =>
        orchForFinalize.finalizeCommit(group, delivery, worktreePath),
      /** Stub: return a fake PR number without calling gh. */
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
// Test
// ---------------------------------------------------------------------------

test('start-flow: plan→work→PR open transitions prGroups[0].status to awaiting-pr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    // An initial commit is required so `git worktree add` has a base branch to check out from.
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const mockModel = makeMockModel();

    const result = await runStart(
      { kind: 'start', goal: 'add hello' },
      {
        cwd: repo.path,
        homeDir: repo.path, // no global config in the temp dir
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        runLoop: makeRunLoop(mockModel),
      },
    );

    assert.equal(result.code, 0, `unexpected exit code: ${result.message ?? ''}`);

    // 1. State: prGroups[0].status must be 'awaiting-pr'.
    const stateStore = new StateStore(join(repo.path, '.ai-task-master'));
    const state = await stateStore.read();
    assert.equal(state.prGroups.length, 1, 'expected exactly one PR group in state');
    const grp = state.prGroups[0];
    assert.ok(grp !== undefined, 'prGroups[0] must exist');
    assert.equal(grp.status, 'awaiting-pr', 'prGroups[0].status must be awaiting-pr');
    assert.equal(grp.pr, 1, 'prGroups[0].pr must be 1 (the stubbed PR number)');

    // 2. Branch aitm/hello must exist in the repo.
    const { stdout: branchList } = await execa('git', ['branch', '--list', 'aitm/hello'], {
      cwd: repo.path,
    });
    assert.ok(branchList.trim().length > 0, 'branch aitm/hello must exist in the repo');

    // 3. hello.ts must be present on the branch.
    const { stdout: fileContent } = await execa('git', ['show', 'aitm/hello:hello.ts'], {
      cwd: repo.path,
    });
    assert.ok(fileContent.includes('hello'), 'hello.ts on aitm/hello must contain "hello"');

    // 4. At least one commit with the amended message must exist on the branch.
    const { stdout: log } = await execa('git', ['log', '--oneline', 'aitm/hello'], {
      cwd: repo.path,
    });
    assert.ok(log.trim().length > 0, 'aitm/hello must have at least one commit');
    assert.ok(
      log.includes('feat: add hello'),
      `expected "feat: add hello" in git log, got:\n${log}`,
    );
  } finally {
    await repo.cleanup();
  }
});

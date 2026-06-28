// End-to-end through the real run-loop-adapter: runStart → defaultRunLoop's twin (runLoopAdapter)
// → real WorktreePool + PlanGraph + live state proxy + WorkLoop, against a real temp git repo.
//
// Only two boundaries are stubbed, both via the adapter's seams:
//   - planGroups: canned PR group (no real Planner LLM call)
//   - makeOrchestrator: Worker writes a file + commits (real git), finalizeCommit runs the real
//     Orchestrator.finalizeCommit through MockLanguageModelV3, openPr/runReviewer are inert
//   - makeGithub: no real `gh` — defaultBranch is read from git, CI is green, no review threads
//
// This is the coverage the prior integration tests lacked: they hand-rolled the loop, whereas
// this drives the production wiring in src/loop/run-loop-adapter.ts.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { execa } from 'execa';
import type { RunLoopInput } from '../../src/cli/commands.ts';
import { runStart } from '../../src/cli/commands.ts';
import type { PullRequest } from '../../src/github/schema.ts';
import { runLoopAdapter } from '../../src/loop/run-loop-adapter.ts';
import type {
  WorkLoopGithub,
  WorkLoopOrchestrator,
  WorkLoopResult,
} from '../../src/loop/work-loop.ts';
import { Orchestrator } from '../../src/orchestrator/orchestrator.ts';
import type { PrGroup } from '../../src/state/schema.ts';
import { StateStore } from '../../src/state/state-store.ts';
import type { WorkerDelivery } from '../../src/subagents/worker.ts';
import { makeTempRepo } from '../../src/testing/temp-repo.ts';

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

const PLAN_GROUP: PrGroup = {
  id: 'hello',
  title: 'add hello',
  tasks: ['create hello.ts with a simple export'],
  dependsOn: [],
  branch: 'aitm/hello',
  pr: null,
  status: 'pending',
};

// Builds the seams that drive runLoopAdapter through real git while stubbing the model boundary.
function integrationSeams(mockModel: MockLanguageModelV3, defaultBranch: string) {
  return (input: RunLoopInput): Promise<WorkLoopResult> =>
    runLoopAdapter(input, {
      planGroups: async () => ({ kind: 'ok', groups: [PLAN_GROUP] }),
      makeGithub: (): WorkLoopGithub => ({
        defaultBranch: async () => defaultBranch,
        waitForChecks: async () => ({ state: 'success' as const, failedChecks: [] }),
        listUnresolvedThreads: async () => [],
        mergePr: async () => {},
      }),
      makeOrchestrator: (): WorkLoopOrchestrator => {
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
        return {
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
      },
    });
}

test('adapter start-flow: runStart → runLoopAdapter drives real pool/graph/git to awaiting-pr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo.path,
    });

    const result = await runStart(
      { kind: 'start', goal: 'add hello', autoMerge: false },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        runLoop: integrationSeams(makeMockModel(), branch.trim()),
      },
    );

    assert.equal(result.code, 0, `unexpected exit: ${result.message ?? ''}`);
    assert.match(result.message ?? '', /merge-pr/, 'awaiting-pr message expected');

    // State: the adapter persisted the plan and the loop drove the group to awaiting-pr.
    const store = new StateStore(join(repo.path, '.ai-task-master'));
    const state = await store.read();
    assert.equal(state.prGroups.length, 1);
    assert.equal(state.prGroups[0]?.status, 'awaiting-pr');
    assert.equal(state.prGroups[0]?.pr, 1);
    assert.equal(state.currentPr, 1, 'currentPr persisted for merge-pr pickup');

    // Real git artifacts from the real WorktreePool + Orchestrator.finalizeCommit.
    const { stdout: branchList } = await execa('git', ['branch', '--list', 'aitm/hello'], {
      cwd: repo.path,
    });
    assert.ok(branchList.trim().length > 0, 'branch aitm/hello must exist');
    const { stdout: file } = await execa('git', ['show', 'aitm/hello:hello.ts'], {
      cwd: repo.path,
    });
    assert.ok(file.includes('hello'), 'hello.ts must be committed on the branch');
    const { stdout: log } = await execa('git', ['log', '--oneline', 'aitm/hello'], {
      cwd: repo.path,
    });
    assert.ok(log.includes('feat: add hello'), `expected amended commit, got:\n${log}`);
  } finally {
    await repo.cleanup();
  }
});

test('adapter start-flow: planner blocked propagates to exit 1', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    const result = await runStart(
      { kind: 'start', goal: 'unbuildable' },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        runLoop: (input) =>
          runLoopAdapter(input, {
            planGroups: async () => ({ kind: 'blocked', reason: 'goal is not actionable' }),
          }),
      },
    );

    assert.equal(result.code, 1);
    assert.match(result.message ?? '', /goal is not actionable/);

    // No aitm/* branches when planning blocks before any worktree work.
    const { stdout: branches } = await execa('git', ['branch', '--list', 'aitm/*'], {
      cwd: repo.path,
    });
    assert.equal(branches.trim(), '', 'no branches should be created on a planner block');
  } finally {
    await repo.cleanup();
  }
});

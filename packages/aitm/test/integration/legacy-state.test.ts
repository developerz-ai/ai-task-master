// Integration: legacy state.json (pre Task[] + pre stage-machine shapes) loads and runs.
//
// Legacy `state.json` has:
//   - prGroups[].tasks: string[]  (bare text, not Task objects)
//   - No prGroups[].stage field
//
// Test 1 — coercion unit check:
//   Seed legacy state.json directly; StateStore.read() must coerce string[] tasks → Task[]
//   and infer stage from status/pr without throwing. Covers pending, merged, and open-PR groups.
//
// Test 2 — full run:
//   Seed legacy state.json, run runStart with a stubbed runLoop. Asserts:
//   - runStart detects resume (runId preserved — state.init NOT called again)
//   - runLoop receives Task[] (not string[]) from the coerced state
//   - WorkLoop creates the branch, runs the Worker, opens the stub PR
//   - Group transitions to awaiting-pr in the final persisted state

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { InPlaceCheckout } from '../../src/workspace/in-place-checkout.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Legacy state.json shape: string[] tasks, no stage field on any group. */
function makeLegacyStateJson(opts: {
  runId: string;
  groupBranch: string | null;
  groupPr: number | null;
  groupStatus: string;
}): string {
  return JSON.stringify(
    {
      status: 'working',
      prGroups: [
        {
          id: 'hello',
          title: 'add hello',
          // Legacy: bare string[], not Task[]
          tasks: ['create hello.ts with a simple export'],
          dependsOn: [],
          branch: opts.groupBranch,
          pr: opts.groupPr,
          status: opts.groupStatus,
          // Intentionally absent: `stage`
        },
      ],
      currentGroupIndex: 0,
      currentTaskIndex: 0,
      sessionCount: 0,
      currentPr: null,
      runId: opts.runId,
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4-5',
      agentConfigFile: 'CLAUDE.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      options: {
        autoMerge: false,
        // Intentionally absent: `prPerTask` (schema defaults to false)
        maxPrs: 20,
        maxSessions: null,
        mergeMethod: 'squash',
        stylePath: null,
        concurrency: 2,
      },
    },
    null,
    2,
  );
}

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

// ---------------------------------------------------------------------------
// Test 1: Coercion — string[] tasks + missing stage → Task[] + inferred stage
// ---------------------------------------------------------------------------

test('legacy-state: StateStore.read() coerces string[] tasks to Task[] and infers stage', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const stateDir = join(repo.path, '.ai-task-master');
    await mkdir(stateDir, { recursive: true });

    // Three groups covering each inferred-stage branch:
    //   pending (no pr, not merged) → 'pending'
    //   merged (status=merged) → 'merged'
    //   open-pr (pr!=null, not merged) → 'waiting-ci'
    const legacyState = {
      status: 'working',
      prGroups: [
        {
          id: 'group-a',
          title: 'pending work',
          tasks: ['task one text', 'task two text'],
          dependsOn: [],
          branch: null,
          pr: null,
          status: 'pending',
          // no `stage`
        },
        {
          id: 'group-b',
          title: 'already merged',
          tasks: ['some finished task'],
          dependsOn: [],
          branch: 'aitm/group-b',
          pr: 42,
          status: 'merged',
          // no `stage`
        },
        {
          id: 'group-c',
          title: 'pr open awaiting ci',
          tasks: ['another task'],
          dependsOn: [],
          branch: 'aitm/group-c',
          pr: 7,
          status: 'awaiting-pr',
          // no `stage` — should infer 'waiting-ci' because pr != null and not merged
        },
      ],
      currentGroupIndex: 0,
      currentTaskIndex: 0,
      sessionCount: 1,
      currentPr: null,
      runId: 'legacy-coerce-test',
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4-5',
      agentConfigFile: 'CLAUDE.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      options: {
        autoMerge: true,
        maxPrs: 20,
        maxSessions: null,
        mergeMethod: 'squash',
        stylePath: null,
        concurrency: 2,
      },
    };

    await writeFile(join(stateDir, 'state.json'), JSON.stringify(legacyState, null, 2));

    const store = new StateStore(stateDir);
    const state = await store.read();

    // ── group-a: pending, no pr ─────────────────────────────────────────────
    const groupA = state.prGroups[0];
    assert.ok(groupA !== undefined, 'prGroups[0] must exist');

    // string[] tasks coerced to Task[]
    assert.equal(groupA.tasks.length, 2, 'group-a must have 2 tasks');
    const task0 = groupA.tasks[0];
    assert.ok(task0 !== undefined, 'task0 must exist');
    assert.equal(typeof task0, 'object', 'tasks[0] must be a Task object, not a string');
    assert.equal(task0.text, 'task one text');
    assert.equal(task0.complexity, 'normal', 'coerced task must default complexity to normal');
    assert.equal(task0.done, false, 'coerced task must default done to false');
    assert.ok(task0.id.length > 0, 'coerced task must have a non-empty slug id');

    const task1 = groupA.tasks[1];
    assert.ok(task1 !== undefined, 'task1 must exist');
    assert.equal(task1.text, 'task two text');

    // stage inferred: no pr, not merged → 'pending'
    assert.equal(groupA.stage, 'pending', 'pending group must get stage=pending');

    // prPerTask option defaulted from absent field
    assert.equal(state.options.prPerTask, false, 'prPerTask must default to false when absent');

    // ── group-b: merged ─────────────────────────────────────────────────────
    const groupB = state.prGroups[1];
    assert.ok(groupB !== undefined, 'prGroups[1] must exist');
    assert.equal(groupB.stage, 'merged', 'merged group must get stage=merged');

    const taskB = groupB.tasks[0];
    assert.ok(taskB !== undefined);
    assert.equal(typeof taskB, 'object', 'tasks must be coerced in merged groups too');
    assert.equal(taskB.text, 'some finished task');

    // ── group-c: awaiting-pr (pr!=null, not merged) ─────────────────────────
    const groupC = state.prGroups[2];
    assert.ok(groupC !== undefined, 'prGroups[2] must exist');
    assert.equal(
      groupC.stage,
      'waiting-ci',
      'group with pr!=null and not merged must get stage=waiting-ci',
    );
  } finally {
    await repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 2: Full run — legacy state.json → resume → WorkLoop → awaiting-pr
// ---------------------------------------------------------------------------

test('legacy-state: runStart resumes from legacy state.json and drives WorkLoop to awaiting-pr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await execa('git', ['add', 'CLAUDE.md'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'initial commit'], { cwd: repo.path });

    // Seed .ai-task-master/ with a legacy state.json before runStart.
    const stateDir = join(repo.path, '.ai-task-master');
    await mkdir(stateDir, { recursive: true });
    await mkdir(join(stateDir, 'logs'), { recursive: true });

    const LEGACY_RUN_ID = 'legacy-run-xyz999';

    // Legacy shape: tasks as string[], no stage, missing prPerTask in options.
    await writeFile(
      join(stateDir, 'state.json'),
      makeLegacyStateJson({
        runId: LEGACY_RUN_ID,
        groupBranch: null,
        groupPr: null,
        groupStatus: 'pending',
      }),
    );

    const mockModel = makeMockModel();

    const result = await runStart(
      { kind: 'start', goal: 'add hello' },
      {
        cwd: repo.path,
        homeDir: repo.path,
        env: { OPENROUTER_API_KEY: 'test-key-x' },
        authStatus: async () => ({ ok: true, scopes: ['repo'] }),
        // Stub: skip real LLM call for style distillation.
        resolveStyle: async () => '# CLAUDE.md\n',
        runLoop: async (input: RunLoopInput): Promise<WorkLoopResult> => {
          // Read the already-persisted (coerced) state — do NOT re-seed prGroups from scratch.
          // This is the authentic resume path: the loop works with whatever coercion produced.
          const currentState = await input.state.read();

          // Assert coercion: the runLoop must see Task objects, not raw strings.
          const g0 = currentState.prGroups[0];
          assert.ok(g0 !== undefined, 'prGroups[0] must exist in coerced state');
          const t0 = g0.tasks[0];
          assert.ok(t0 !== undefined, 'tasks[0] must exist');
          assert.equal(
            typeof t0,
            'object',
            'tasks[0] must be a Task object after coercion (not a string)',
          );
          assert.equal(t0.text, 'create hello.ts with a simple export');

          let liveGroups: readonly PrGroup[] = currentState.prGroups;

          const workLoopState = {
            update: async (mutator: (s: RunState) => RunState): Promise<RunState> => {
              const next = await input.state.update(mutator);
              liveGroups = next.prGroups;
              return next;
            },
          };

          const graph = {
            ready: () => new PlanGraph([...liveGroups]).ready(),
            isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
          };

          const { stdout: rawBranch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: input.cwd,
          });
          const defaultBranch = rawBranch.trim();

          const home = new InPlaceCheckout(input.cwd);

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
            runWorker: async ({ checkout }) => {
              await writeFile(join(checkout.path, 'hello.ts'), 'export const hello = "hello";\n');
              await execa('git', ['add', 'hello.ts'], { cwd: checkout.path });
              await execa('git', ['commit', '-m', 'wip: add hello'], { cwd: checkout.path });
              const delivery: WorkerDelivery = {
                branch: checkout.branch,
                draftCommitMessage: 'feat: add hello',
                changes: [{ path: 'hello.ts', kind: 'create', summary: 'creates hello export' }],
                progressEntries: ['- created hello.ts'],
              };
              return { kind: 'ok', delivery };
            },
            finalizeCommit: (group, delivery, checkoutPath) =>
              orchForFinalize.finalizeCommit(group, delivery, checkoutPath),
            openPr: async (group, _delivery, baseBranch): Promise<PullRequest> => ({
              number: 1,
              state: 'OPEN',
              url: 'https://github.com/example/repo/pull/1',
              headRefName: group.branch ?? `aitm/${group.id}`,
              baseRefName: baseBranch,
            }),
            runReviewer: async () => ({ kind: 'ok', resolutions: [] }),
            runCiFix: async () => ({ kind: 'ok' }),
            addressReviews: async () => ({ kind: 'ok' }),
          };

          const github = {
            defaultBranch: async () => defaultBranch,
            waitForChecks: async () => ({ state: 'success' as const, failedChecks: [] }),
            listUnresolvedThreads: async () => [],
            mergePr: async () => {},
          };

          const loop = new WorkLoop({
            orchestrator: stubOrchestrator,
            github,
            state: workLoopState,
            home,
            graph,
            concurrency: input.resolved.concurrency,
            autoMerge: false,
            maxSessions: null,
          });

          return loop.run();
        },
      },
    );

    assert.equal(result.code, 0, `unexpected exit code: ${result.message ?? ''}`);

    // 1. runId preserved — runStart detected resume, did NOT call state.init again.
    const store = new StateStore(stateDir);
    const finalState = await store.read();
    assert.equal(
      finalState.runId,
      LEGACY_RUN_ID,
      `runId must be the legacy value (resume, not re-init), got: ${finalState.runId}`,
    );

    // 2. prGroups[0] transitioned to awaiting-pr with stub PR number.
    const grp = finalState.prGroups[0];
    assert.ok(grp !== undefined, 'prGroups[0] must exist in final state');
    assert.equal(grp.status, 'awaiting-pr', 'group must transition to awaiting-pr');
    assert.equal(grp.pr, 1, 'group.pr must be 1 (stubbed)');

    // 3. tasks persisted as Task objects (not string[]) after the run.
    const finalTask = grp.tasks[0];
    assert.ok(finalTask !== undefined, 'tasks[0] must exist in final state');
    assert.equal(typeof finalTask, 'object', 'persisted tasks must be Task objects');
    assert.equal(finalTask.text, 'create hello.ts with a simple export');

    // 4. aitm/hello branch created in the repo.
    const { stdout: branchList } = await execa('git', ['branch', '--list', 'aitm/hello'], {
      cwd: repo.path,
    });
    assert.ok(branchList.trim().length > 0, 'branch aitm/hello must exist after the run');

    // 5. hello.ts landed on the branch.
    const { stdout: fileContent } = await execa('git', ['show', 'aitm/hello:hello.ts'], {
      cwd: repo.path,
    });
    assert.ok(fileContent.includes('hello'), 'hello.ts on aitm/hello must contain "hello"');
  } finally {
    await repo.cleanup();
  }
});

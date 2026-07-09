import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { RunCmd, RunCmdResult } from '../github/github-client.ts';
import type { ReviewThread } from '../github/schema.ts';
import { PrContextStore } from '../state/pr-context-store.ts';
import type { PrGroup } from '../state/schema.ts';
import type { FileManifest, WorkerInput, WorkerResult, WorkerTools } from '../subagents/worker.ts';
import {
  type FixSessionGithub,
  type FixSessionInput,
  type FixSessionPrContext,
  type FixSessionSubagents,
  rebaseAndForcePush,
  runFixSession,
} from './ci-fix.ts';

const dummyModel = new MockLanguageModelV3();

function fakeGithub(
  opts: { failures?: Array<{ check: string; logs: string }>; threads?: ReviewThread[] } = {},
): FixSessionGithub {
  return {
    getFailedCiLogs: async () => opts.failures ?? [],
    listUnresolvedThreads: async () => opts.threads ?? [],
  };
}

// Records every git/gh invocation as a flat "file arg arg" string; `plan` decides each result so a
// test can script a failing rebase without spawning git.
function recordingRunCmd(plan: (args: readonly string[]) => Partial<RunCmdResult> = () => ({})): {
  runCmd: RunCmd;
  commands: string[];
} {
  const commands: string[] = [];
  const runCmd: RunCmd = async (file, args) => {
    commands.push([file, ...args].join(' '));
    const out = plan(args);
    return { stdout: out.stdout ?? '', stderr: out.stderr ?? '', exitCode: out.exitCode ?? 0 };
  };
  return { runCmd, commands };
}

function baseGroup(overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id: 'core',
    title: 'Core features',
    tasks: [{ id: 'core-1', text: 'do the thing', complexity: 'normal', done: false }],
    dependsOn: [],
    branch: 'aitm/core',
    pr: 7,
    status: 'in-progress',
    stage: 'ci-failed',
    ...overrides,
  };
}

function baseSubagents(overrides: Partial<FixSessionSubagents> = {}): FixSessionSubagents {
  return {
    credentials: { modelForCapability: () => dummyModel },
    workerTools: {} as WorkerTools,
    styleContents: '',
    runWorkerOverride: async () => okWorker(),
    ...overrides,
  };
}

function okWorker(): WorkerResult {
  return {
    kind: 'ok',
    delivery: {
      branch: 'aitm/core',
      draftCommitMessage: 'fix: green CI',
      changes: [{ path: 'src/a.ts', kind: 'modify', summary: 'fixed assertion' }],
      progressEntries: ['- fix CI'],
    },
  };
}

function baseInput(overrides: Partial<FixSessionInput> = {}): FixSessionInput {
  return {
    github: fakeGithub(),
    prContext: stubPrContext(),
    subagents: baseSubagents(),
    group: baseGroup(),
    pr: 7,
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    runCmd: recordingRunCmd().runCmd,
    ...overrides,
  };
}

function stubPrContext(): FixSessionPrContext {
  return {
    clear: async () => {},
    saveCiFailures: async () => null,
    saveComments: async () => null,
  };
}

// Emits a single submit tool-call carrying `manifest`; an empty manifest drives runWorker to its
// "blocked: empty manifest" path without ever running an editor or git.
function submitManifestModel(manifest: FileManifest): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'submit-0',
          toolName: 'submit',
          input: JSON.stringify(manifest),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
        totalTokens: 2,
      },
      warnings: [],
    }),
  });
}

test('runFixSession: CI failure → saves logs+comments to disk, fix prompt references those dirs, rebases + force-with-lease', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aitm-cifix-'));
  try {
    const prContext = new PrContextStore(stateDir);
    const threads: ReviewThread[] = [
      {
        id: 'TH_1',
        isResolved: false,
        path: 'src/a.ts',
        comments: [{ id: 'C_1', body: 'rename this', author: 'rabbit' }],
      },
    ];
    const github = fakeGithub({
      failures: [{ check: 'test (node 20)', logs: 'AssertionError: expected 1 to equal 2' }],
      threads,
    });
    const { runCmd, commands } = recordingRunCmd();
    let captured: WorkerInput | null = null;

    const result = await runFixSession(
      baseInput({
        github,
        prContext,
        runCmd,
        subagents: baseSubagents({
          runWorkerOverride: async (input) => {
            captured = input;
            return okWorker();
          },
        }),
      }),
    );

    assert.equal(result.kind, 'fixed');

    // Context landed under debugging/pr/7/{ci,comments}/ in the claudetm layout.
    const ciFiles = await readdir(join(stateDir, 'debugging', 'pr', '7', 'ci'));
    assert.ok(
      ciFiles.some((f) => f.startsWith('failed_') && f.endsWith('.txt')),
      'expected a failed_<check>.txt log file',
    );
    assert.ok(ciFiles.includes('summary.txt'));
    const commentFiles = await readdir(join(stateDir, 'debugging', 'pr', '7', 'comments'));
    assert.ok(
      commentFiles.some((f) => /^\d{3}_/.test(f)),
      'expected an NNN_<path>.txt comment file',
    );

    // The Worker's fix task points at the exact downloaded dirs.
    assert.ok(captured, 'worker was invoked');
    const task = (captured as WorkerInput).task;
    assert.ok(task);
    assert.match(task.text, /debugging.*pr.*7.*ci/s);
    assert.match(task.text, /debugging.*pr.*7.*comments/s);

    // Rebase onto origin/base then force-with-lease — never plain --force, never push before rebase.
    assert.deepEqual(commands, [
      'git fetch origin main',
      'git rebase origin/main',
      'git push --force-with-lease',
    ]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('runFixSession: threads verifyCommand into the fix Worker input (issue #122)', async () => {
  let captured: WorkerInput | null = null;
  const result = await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      subagents: baseSubagents({
        formatCommand: 'bun run lint:fix',
        verifyCommand: 'bun test',
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.equal(result.kind, 'fixed');
  assert.ok(captured, 'worker was invoked');
  assert.equal((captured as WorkerInput).verifyCommand, 'bun test');
  assert.equal((captured as WorkerInput).formatCommand, 'bun run lint:fix');
});

test('runFixSession: clears stale context before downloading (fresh-context-only)', async () => {
  const order: string[] = [];
  const prContext: FixSessionPrContext = {
    clear: async () => {
      order.push('clear');
    },
    saveCiFailures: async () => {
      order.push('saveCiFailures');
      return '/d/ci';
    },
    saveComments: async () => {
      order.push('saveComments');
      return '/d/comments';
    },
  };
  const result = await runFixSession(baseInput({ prContext, runCmd: recordingRunCmd().runCmd }));
  assert.equal(result.kind, 'fixed');
  assert.equal(order[0], 'clear', 'clear must run before any save');
  assert.deepEqual(order, ['clear', 'saveCiFailures', 'saveComments']);
});

test('runFixSession: Worker blocked → session blocked, nothing is pushed', async () => {
  const { runCmd, commands } = recordingRunCmd();
  const result = await runFixSession(
    baseInput({
      runCmd,
      subagents: baseSubagents({
        runWorkerOverride: async () => ({ kind: 'blocked', reason: 'cannot plan a fix' }),
      }),
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /cannot plan a fix/);
  assert.deepEqual(commands, [], 'no git fetch/rebase/push when the Worker did not deliver');
});

test('runFixSession: Worker error → session blocked with the error surfaced', async () => {
  const result = await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      subagents: baseSubagents({
        runWorkerOverride: async () => ({ kind: 'error', error: 'model exploded' }),
      }),
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /worker error.*model exploded/i);
});

test('runFixSession: rebase conflict → blocked, aborts the rebase, never force-pushes', async () => {
  const { runCmd, commands } = recordingRunCmd((args) =>
    args[0] === 'rebase' && args[1]?.startsWith('origin/')
      ? { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/a.ts' }
      : {},
  );
  const result = await runFixSession(baseInput({ runCmd }));
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /conflict/i);
  assert.ok(commands.includes('git rebase --abort'), 'must abort the half-applied rebase');
  assert.ok(!commands.some((c) => c.includes('push')), 'must not push after a failed rebase');
});

// rebaseAndForcePush is the shared push path (also used by the merge-pr take-over loop), so it has
// its own focused coverage beyond the full runFixSession flow above.

test('rebaseAndForcePush: fetch → rebase → push --force-with-lease in order, returns fixed', async () => {
  const { runCmd, commands } = recordingRunCmd();
  const result = await rebaseAndForcePush(runCmd, '/tmp/wt', 'main', 9, undefined);
  assert.equal(result.kind, 'fixed');
  assert.deepEqual(commands, [
    'git fetch origin main',
    'git rebase origin/main',
    'git push --force-with-lease',
  ]);
});

test('rebaseAndForcePush: allowForcePush=false → blocks without running any git', async () => {
  const { runCmd, commands } = recordingRunCmd();
  const result = await rebaseAndForcePush(runCmd, '/tmp/wt', 'main', 9, undefined, false);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /force-push is disabled by policy/);
    // Must not tell the operator to do the very thing policy forbids (a manual rebase/force-push).
    assert.doesNotMatch(result.reason, /rebase onto the base and push/i);
  }
  assert.deepEqual(commands, [], 'must not fetch/rebase/push when force-push is forbidden');
});

test('rebaseAndForcePush: rebase conflict → blocked, aborts, never pushes', async () => {
  const { runCmd, commands } = recordingRunCmd((args) =>
    args[0] === 'rebase' && args[1]?.startsWith('origin/')
      ? { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/a.ts' }
      : {},
  );
  const result = await rebaseAndForcePush(runCmd, '/tmp/wt', 'main', 9, undefined);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /conflict/i);
  assert.ok(commands.includes('git rebase --abort'));
  assert.ok(!commands.some((c) => c.includes('push')));
});

test('rebaseAndForcePush: push rejected → blocked, surfaces the git error', async () => {
  const { runCmd } = recordingRunCmd((args) =>
    args[0] === 'push' ? { exitCode: 1, stderr: 'stale info; remote moved' } : {},
  );
  const result = await rebaseAndForcePush(runCmd, '/tmp/wt', 'main', 9, undefined);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /force-with-lease.*stale/i);
});

test('runFixSession: builds the Worker on the coding-capability model (no hardcoded tier)', async () => {
  const caps: string[] = [];
  const { runCmd, commands } = recordingRunCmd();
  const result = await runFixSession(
    baseInput({
      runCmd,
      subagents: {
        credentials: {
          modelForCapability: (cap) => {
            caps.push(cap);
            // Empty manifest → runWorker blocks before any editor/commit, so workerTools/git
            // are never exercised; we only care that the coding tier was selected.
            return submitManifestModel({ files: [], draftCommitMessage: '' });
          },
        },
        workerTools: {} as WorkerTools,
        styleContents: '',
      },
    }),
  );
  assert.deepEqual(caps, ['coding']);
  assert.equal(result.kind, 'blocked'); // empty manifest
  assert.deepEqual(commands, [], 'a blocked Worker never reaches the git push');
});

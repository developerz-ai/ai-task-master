import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { CiFailed } from '../github/errors.ts';
import type { CiResult, RunCmd, RunCmdResult } from '../github/github-client.ts';
import type { CheckStatus, ReviewThread } from '../github/schema.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerInput, WorkerResult } from '../subagents/worker.ts';
import { runTakeOverFlow, type TakeOverFlowInput, type TakeOverGithub } from './take-over-flow.ts';

type GhCall =
  | { method: 'waitForChecks' }
  | { method: 'listUnresolvedThreads' }
  | { method: 'mergePr' }
  | { method: 'reply'; threadId: string; body: string }
  | { method: 'resolve'; threadId: string };

// The flow only reads CiResult.state, so collapse the scripted CheckStatus into the three CiState
// values: any failed/cancelled status → 'failure', pending → 'pending', everything else → 'success'.
function toCiResult(status: CheckStatus): CiResult {
  if (status === 'failure' || status === 'cancelled') {
    return { state: 'failure', failedChecks: [{ name: 'check', status }] };
  }
  if (status === 'pending') return { state: 'pending', failedChecks: [] };
  return { state: 'success', failedChecks: [] };
}

// Build a github stub whose waitForChecks + listUnresolvedThreads cycle through a scripted
// sequence per call. mergePr / replyToThread / resolveThread are recorded as-is.
function fakeGithub(opts: {
  checks: Array<CheckStatus | 'throw-cifailed'>;
  threads: ReviewThread[][];
  mergePrFails?: boolean;
}): { github: TakeOverGithub; calls: GhCall[] } {
  const calls: GhCall[] = [];
  let checkIdx = 0;
  let threadIdx = 0;
  return {
    calls,
    github: {
      waitForChecks: async () => {
        calls.push({ method: 'waitForChecks' });
        const step = opts.checks[checkIdx++] ?? opts.checks[opts.checks.length - 1] ?? 'success';
        if (step === 'throw-cifailed') throw new CiFailed('CI fail');
        return toCiResult(step);
      },
      listUnresolvedThreads: async () => {
        calls.push({ method: 'listUnresolvedThreads' });
        return opts.threads[threadIdx++] ?? opts.threads[opts.threads.length - 1] ?? [];
      },
      mergePr: async () => {
        calls.push({ method: 'mergePr' });
        if (opts.mergePrFails) throw new Error('merge failed');
      },
      replyToThread: async (threadId, body) => {
        calls.push({ method: 'reply', threadId, body });
      },
      resolveThread: async (threadId) => {
        calls.push({ method: 'resolve', threadId });
      },
    },
  };
}

// Records every git invocation as a flat "file arg arg" string; `plan` decides each result so a
// test can script a failing rebase without spawning git. Mirrors ci-fix.test.ts's helper — the
// take-over loop now pushes through the same rebaseAndForcePush path.
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

// Shared subagent stubs — neither model is invoked because we always pass *Override.
const dummyModel = new MockLanguageModelV3();

function baseInput(
  github: TakeOverGithub,
  overrides: Partial<TakeOverFlowInput> = {},
): TakeOverFlowInput {
  return {
    pr: 42,
    checkoutPath: '/tmp/repo',
    baseBranch: 'main',
    github,
    mergeMethod: 'squash',
    runCmd: recordingRunCmd().runCmd,
    cooldownMs: 0,
    sleep: async () => {},
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () =>
        ({
          kind: 'ok',
          resolutions: [],
        }) satisfies ReviewerResult,
      runWorkerOverride: async () =>
        ({
          kind: 'blocked',
          reason: 'no worker fix in test',
        }) satisfies WorkerResult,
    },
    ...overrides,
  };
}

test('runTakeOverFlow: CI green + no threads → merges immediately', async () => {
  const gh = fakeGithub({ checks: ['success'], threads: [[]] });
  const result = await runTakeOverFlow(baseInput(gh.github));
  assert.equal(result.kind, 'merged');
  // Broke on the first pass (CI already green, no threads) → zero fix iterations ran.
  if (result.kind === 'merged') assert.equal(result.iterations, 0);
  assert.deepEqual(
    gh.calls.map((c) => c.method),
    ['waitForChecks', 'listUnresolvedThreads', 'waitForChecks', 'listUnresolvedThreads', 'mergePr'],
  );
});

test('runTakeOverFlow: unresolved threads → invokes Reviewer, pushes, then merges', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_1',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_1', body: 'fix', author: 'rabbit' }],
    },
  ];
  // 1st iteration: threads present, reviewer runs. 2nd iteration: clean. Then final merge.
  const gh = fakeGithub({
    checks: ['success', 'success', 'success'],
    threads: [threads, []],
  });
  const { runCmd, commands } = recordingRunCmd();
  let reviewerInvocations = 0;
  const input = baseInput(gh.github, {
    runCmd,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async (rin) => {
        reviewerInvocations++;
        assert.equal(rin.pr, 42);
        assert.equal(rin.threads.length, 1);
        return {
          kind: 'ok',
          resolutions: [{ threadId: 'TH_1', kind: 'fixed', commitSha: 'abc123' }],
        };
      },
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'merged');
  // One fix iteration ran (threads → reviewer → push), then iteration 1 was clean → merge.
  if (result.kind === 'merged') assert.equal(result.iterations, 1);
  assert.equal(reviewerInvocations, 1);
  // Pushed once after Reviewer fixed something — through the shared rebase-first force-with-lease
  // helper, never a plain push and never plain --force.
  assert.deepEqual(commands, [
    'git fetch origin main',
    'git rebase origin/main',
    'git push --force-with-lease',
  ]);
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 1);
});

test('runTakeOverFlow: CI failure → invokes Worker, blocks if Worker blocked', async () => {
  const gh = fakeGithub({ checks: ['throw-cifailed'], threads: [[]] });
  const result = await runTakeOverFlow(baseInput(gh.github));
  // Worker override returns blocked → flow blocks before merge.
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /no worker fix in test|worker/i);
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 0);
});

test('runTakeOverFlow: threads timeout into the real take-over Worker → a stalled step blocks (issue #129)', async () => {
  // CI failed → the Worker runs. With no runWorkerOverride the real agent is built with the
  // forwarded per-step deadline; a stalled model is aborted at { stepMs: 40 } and blocks the flow.
  const gh = fakeGithub({ checks: ['throw-cifailed'], threads: [[]] });
  const stalling = new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
  const result = await runTakeOverFlow(
    baseInput(gh.github, {
      subagents: {
        reviewerModel: dummyModel,
        reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
        workerModel: stalling,
        workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
        styleContents: '',
        timeout: { stepMs: 40 },
      },
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /exceeded the configured deadline/);
});

test('runTakeOverFlow: threads verifyCommand into the CI-fix Worker input (issue #122)', async () => {
  const gh = fakeGithub({ checks: ['throw-cifailed'], threads: [[]] });
  let captured: WorkerInput | null = null;
  const input = baseInput(gh.github, {
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      formatCommand: 'bun run lint:fix',
      verifyCommand: 'bun test',
      runWorkerOverride: async (win) => {
        captured = win;
        return { kind: 'blocked', reason: 'stop here' } satisfies WorkerResult;
      },
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  assert.ok(captured, 'CI-fix worker was invoked');
  assert.equal((captured as WorkerInput).verifyCommand, 'bun test');
  assert.equal((captured as WorkerInput).formatCommand, 'bun run lint:fix');
});

test('runTakeOverFlow: max iterations exhausted with threads remaining → blocked', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_X',
      isResolved: false,
      path: null,
      comments: [{ id: 'C_X', body: 'todo', author: 'rabbit' }],
    },
  ];
  const gh = fakeGithub({
    // Always green CI, but threads never go away. Reviewer "fixes" them but our stubbed
    // listUnresolvedThreads keeps returning them — simulating Reviewer not actually
    // resolving on the API. Flow should bail with a max-iterations message.
    checks: ['success'],
    threads: [threads],
  });
  const input = baseInput(gh.github, {
    maxIterations: 2,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => ({
        kind: 'ok',
        resolutions: [{ threadId: 'TH_X', kind: 'fixed', commitSha: 'def456' }],
      }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /unresolved thread/i);
    assert.equal(result.iterations, 2);
  }
});

test('runTakeOverFlow: aborted signal → cancelled before any merge', async () => {
  const gh = fakeGithub({ checks: ['success'], threads: [[]] });
  const controller = new AbortController();
  controller.abort();
  const result = await runTakeOverFlow(baseInput(gh.github, { signal: controller.signal }));
  assert.equal(result.kind, 'cancelled');
  // Bailed on the very first iteration check → zero iterations, never polled CI or merged.
  if (result.kind === 'cancelled') assert.equal(result.iterations, 0);
  assert.deepEqual(gh.calls, [], 'no gh calls once cancelled up front');
});

test('runTakeOverFlow: signal aborted mid-flow → cancelled, no merge', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_M',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_M', body: 'fix', author: 'rabbit' }],
    },
  ];
  // CI green but threads present → iteration 0 runs the Reviewer, pushes, then sleeps. The sleep
  // aborts, so iteration 1's top-of-loop check bails to `cancelled` before any merge.
  const gh = fakeGithub({ checks: ['success'], threads: [threads, []] });
  const controller = new AbortController();
  const input = baseInput(gh.github, {
    signal: controller.signal,
    cooldownMs: 1,
    sleep: async () => {
      controller.abort();
    },
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => ({
        kind: 'ok',
        resolutions: [{ threadId: 'TH_M', kind: 'fixed', commitSha: 'abc' }],
      }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'cancelled');
  if (result.kind === 'cancelled') assert.equal(result.iterations, 1);
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 0);
});

test('runTakeOverFlow: Reviewer error → blocked, no merge', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_1',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_1', body: 'x', author: 'r' }],
    },
  ];
  const gh = fakeGithub({ checks: ['success'], threads: [threads] });
  const input = baseInput(gh.github, {
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => ({
        kind: 'error',
        error: 'model exploded',
        resolutions: [],
      }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /reviewer error.*model exploded/i);
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 0);
});

test('runTakeOverFlow: Reviewer errors mid-pass with completed fixes → pushes them before blocking', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_E',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_E', body: 'fix', author: 'rabbit' }],
    },
  ];
  const gh = fakeGithub({ checks: ['success'], threads: [threads] });
  const { runCmd, commands } = recordingRunCmd();
  const input = baseInput(gh.github, {
    runCmd,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      // The pass threw on a later thread, but TH_E was already fixed + committed locally first.
      // Those completed fixes must reach the remote before the run blocks (durability #4).
      runReviewerOverride: async () => ({
        kind: 'error',
        error: 'model exploded on the next thread',
        resolutions: [{ threadId: 'TH_E', kind: 'fixed', commitSha: 'abc123' }],
      }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /reviewer error.*model exploded/i);
    assert.equal(result.iterations, 0);
  }
  assert.ok(
    commands.includes('git push --force-with-lease'),
    `the completed fix must be pushed before blocking, got: ${commands.join(' | ')}`,
  );
  assert.equal(
    gh.calls.filter((c) => c.method === 'mergePr').length,
    0,
    'never merges on a reviewer error',
  );
});

test('runTakeOverFlow: rebase conflict on push → blocked, aborts, never force-pushes', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_C',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_C', body: 'fix', author: 'rabbit' }],
    },
  ];
  const gh = fakeGithub({ checks: ['success'], threads: [threads] });
  // Reviewer "fixes" → something to push → rebase onto origin/main conflicts. The flow must abort
  // the half-applied rebase and block cleanly, never reaching the force-push or the merge.
  const { runCmd, commands } = recordingRunCmd((args) =>
    args[0] === 'rebase' && args[1]?.startsWith('origin/')
      ? { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/a.ts' }
      : {},
  );
  const input = baseInput(gh.github, {
    runCmd,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => ({
        kind: 'ok',
        resolutions: [{ threadId: 'TH_C', kind: 'fixed', commitSha: 'abc' }],
      }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /conflict/i);
  assert.ok(commands.includes('git rebase --abort'), 'aborts the half-applied rebase');
  assert.ok(!commands.some((c) => c.includes('push')), 'never force-pushes after a failed rebase');
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 0);
});

test('runTakeOverFlow: rebase conflict + AI resolver resolves → continues, force-pushes, then merges', async () => {
  const thread: ReviewThread = {
    id: 'TH_R',
    isResolved: false,
    path: 'src/a.ts',
    comments: [{ id: 'C_R', body: 'fix', author: 'rabbit' }],
  };
  // Iteration 1: CI green + a thread → Reviewer fixes → push. The rebase conflicts; the AI resolver
  // resolves it and the flow continues onto the force-push. Iteration 2: green + no threads → merge.
  const gh = fakeGithub({ checks: ['success', 'success'], threads: [[thread], []] });
  let diff = 0;
  const { runCmd, commands } = recordingRunCmd((args) => {
    if (args[0] === 'rebase' && args[1]?.startsWith('origin/')) {
      return { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/a.ts' };
    }
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
      diff++;
      return diff <= 1 ? { stdout: 'src/a.ts' } : { stdout: '' };
    }
    return {};
  });
  let resolverCalls = 0;
  const input = baseInput(gh.github, {
    runCmd,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => ({
        kind: 'ok',
        resolutions: [{ threadId: 'TH_R', kind: 'fixed', commitSha: 'abc' }],
      }),
      resolveConflicts: async () => {
        resolverCalls++;
        return { kind: 'resolved' };
      },
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'merged');
  assert.equal(resolverCalls, 1, 'AI resolver was invoked once for the conflict');
  assert.ok(commands.includes('git -c core.editor=true rebase --continue'), 'continues the rebase');
  assert.ok(commands.includes('git push --force-with-lease'), 'force-pushes after resolving');
  assert.ok(!commands.includes('git rebase --abort'), 'never aborts a resolved rebase');
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 1);
});

test('runTakeOverFlow: conflict + resolver gives up → aborts + blocks, never merges', async () => {
  const thread: ReviewThread = {
    id: 'TH_U',
    isResolved: false,
    path: 'src/a.ts',
    comments: [{ id: 'C_U', body: 'fix', author: 'rabbit' }],
  };
  const gh = fakeGithub({ checks: ['success'], threads: [[thread]] });
  const { runCmd, commands } = recordingRunCmd((args) => {
    if (args[0] === 'rebase' && args[1]?.startsWith('origin/')) {
      return { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/a.ts' };
    }
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) return { stdout: 'src/a.ts' };
    return {};
  });
  const input = baseInput(gh.github, {
    runCmd,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      workerModel: dummyModel,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => ({
        kind: 'ok',
        resolutions: [{ threadId: 'TH_U', kind: 'fixed', commitSha: 'abc' }],
      }),
      resolveConflicts: async () => ({ kind: 'unresolved', reason: 'too tangled' }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /could not resolve.*too tangled/i);
  assert.ok(commands.includes('git rebase --abort'));
  assert.ok(!commands.some((c) => c.includes('push')));
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 0);
});

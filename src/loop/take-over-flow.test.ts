import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { CiFailed } from '../github/errors.ts';
import type { CheckStatus, ReviewThread } from '../github/schema.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerResult } from '../subagents/worker.ts';
import { runTakeOverFlow, type TakeOverFlowInput, type TakeOverGithub } from './take-over-flow.ts';

type GhCall =
  | { method: 'waitForChecks' }
  | { method: 'listUnresolvedThreads' }
  | { method: 'mergePr' }
  | { method: 'reply'; threadId: string; body: string }
  | { method: 'resolve'; threadId: string };

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
        return step;
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

// Shared subagent stubs — neither model is invoked because we always pass *Override.
const dummyModel = new MockLanguageModelV3();

function baseInput(
  github: TakeOverGithub,
  overrides: Partial<TakeOverFlowInput> = {},
): TakeOverFlowInput {
  return {
    pr: 42,
    worktreePath: '/tmp/repo',
    baseBranch: 'main',
    github,
    mergeMethod: 'squash',
    push: async () => {},
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
  let pushed = 0;
  let reviewerInvocations = 0;
  const input = baseInput(gh.github, {
    push: async () => {
      pushed++;
    },
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
  assert.equal(reviewerInvocations, 1);
  assert.equal(pushed, 1, 'must push after Reviewer fixed something');
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
      runReviewerOverride: async () => ({ kind: 'error', error: 'model exploded' }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /reviewer error.*model exploded/i);
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 0);
});

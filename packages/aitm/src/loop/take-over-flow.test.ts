import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { CiFailed } from '../github/errors.ts';
import type { CiResult, RunCmd, RunCmdResult } from '../github/github-client.ts';
import type { CheckStatus, ReviewThread } from '../github/schema.ts';
import type { ReviewerResult } from '../subagents/reviewer.ts';
import type { WorkerInput, WorkerResult } from '../subagents/worker.ts';
import type { FixSessionModelSelector } from './ci-fix.ts';
import { REVIEW_COMMENTS_GRACE } from './constants.ts';
import {
  type PrContextPort,
  runTakeOverFlow,
  type TakeOverFlowInput,
  type TakeOverGithub,
} from './take-over-flow.ts';

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
      // Read only by runFixSession on the CI-red path; kept out of `calls` so the green-path call-
      // sequence assertions stay unaffected.
      getFailedCiLogs: async () => [],
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

// The take-over CI-fix path now runs through ci-fix.ts's runFixSession, which selects the coding
// tier itself — so tests supply a model selector instead of a bare worker handle.
const fakeCredentials = (model: LanguageModel): FixSessionModelSelector => ({
  modelForCapability: () => model,
  modelIdForCapability: () => 'test/coding-model',
});
const dummyCredentials = fakeCredentials(dummyModel);

// runFixSession clears + writes the downloaded CI context through this port; a no-op stub is enough
// since the CI-fix tests drive the Worker via runWorkerOverride. The addressed-thread ledger is
// backed by a real in-memory Set per instance so dedup tests can observe it working across
// iterations, mirroring how PrContextStore actually persists it.
function fakePrContext(): PrContextPort {
  const addressed = new Map<number, Set<string>>();
  return {
    clearCi: async () => {},
    clearComments: async () => {},
    saveCiFailures: async () => null,
    saveComments: async () => null,
    readAddressedThreads: async (pr) => new Set(addressed.get(pr) ?? []),
    recordAddressedThreads: async (pr, ids) => {
      const set = addressed.get(pr) ?? new Set<string>();
      for (const id of ids) set.add(id);
      addressed.set(pr, set);
    },
  };
}

function baseInput(
  github: TakeOverGithub,
  overrides: Partial<TakeOverFlowInput> = {},
): TakeOverFlowInput {
  return {
    pr: 42,
    checkoutPath: '/tmp/repo',
    baseBranch: 'main',
    github,
    prContext: fakePrContext(),
    mergeMethod: 'squash',
    runCmd: recordingRunCmd().runCmd,
    cooldownMs: 0,
    sleep: async () => {},
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      credentials: dummyCredentials,
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
      credentials: dummyCredentials,
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

test('runTakeOverFlow: replied-only thread is recorded as addressed → not re-fed to the Reviewer', async () => {
  // GitHub never marks the thread resolved (only a reply, by design for "replied"), so
  // listUnresolvedThreads keeps returning it forever. Without the addressed-thread dedup this
  // would loop the Reviewer over the same thread every iteration.
  const threads: ReviewThread[] = [
    {
      id: 'TH_D',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_D', body: 'why?', author: 'rabbit' }],
    },
  ];
  const gh = fakeGithub({ checks: ['success', 'success'], threads: [threads] });
  let reviewerInvocations = 0;
  const input = baseInput(gh.github, {
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      credentials: dummyCredentials,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => {
        reviewerInvocations++;
        return { kind: 'ok', resolutions: [{ threadId: 'TH_D', kind: 'replied' }] };
      },
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'merged');
  // The Reviewer ran exactly once — the second iteration's freshThreads filtered TH_D out even
  // though listUnresolvedThreads keeps reporting it unresolved.
  assert.equal(reviewerInvocations, 1);
  if (result.kind === 'merged') assert.equal(result.iterations, 1);
});

test('runTakeOverFlow: review grace re-arms after a push', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_G',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_G', body: 'fix', author: 'rabbit' }],
    },
  ];
  // 1st iteration: green CI + a thread the Reviewer fixes → pushes. 2nd iteration: green + clean.
  const gh = fakeGithub({ checks: ['success', 'success'], threads: [threads, []] });
  const graceSleeps: number[] = [];
  const input = baseInput(gh.github, {
    sleep: async (ms) => {
      if (ms === REVIEW_COMMENTS_GRACE) graceSleeps.push(ms);
    },
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      credentials: dummyCredentials,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => ({
        kind: 'ok',
        resolutions: [{ threadId: 'TH_G', kind: 'fixed', commitSha: 'abc' }],
      }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'merged');
  // The grace fired once before the fixing pass and a second time after the push re-armed it —
  // a once-only grace would have only ever waited for review bots against the pre-push head.
  assert.equal(graceSleeps.length, 2);
});

test('runTakeOverFlow: CI stays pending → retries without reading threads, then blocks', async () => {
  // waitForChecks only ever returns 'pending' on a cancelled poll, but a non-aborted 'pending' can
  // still theoretically reach the loop (a race between the abort check and the signal firing) — it
  // must be treated as "not settled yet", not fall through to the Reviewer/merge logic below it.
  const gh = fakeGithub({ checks: ['pending'], threads: [[]] });
  const result = await runTakeOverFlow(baseInput(gh.github, { maxIterations: 2 }));
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /CI pending after 2 iteration/i);
    assert.equal(result.iterations, 2);
  }
  assert.deepEqual(
    gh.calls.map((c) => c.method),
    ['waitForChecks', 'waitForChecks', 'waitForChecks', 'listUnresolvedThreads'],
    'threads are only read on the final settle check, never mid-loop while CI is pending',
  );
});

test('runTakeOverFlow: CI failure → invokes Worker, blocks if Worker blocked', async () => {
  const gh = fakeGithub({ checks: ['throw-cifailed'], threads: [[]] });
  const result = await runTakeOverFlow(baseInput(gh.github));
  // Worker override returns blocked → flow blocks before merge.
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /no worker fix in test|worker/i);
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 0);
});

test('runTakeOverFlow: CI red + Worker returns no-changes → blocks, no force-push, no merge', async () => {
  // A red CI the Worker declares needs no changes is a contradiction — nothing was committed, so
  // force-pushing zero commits and re-polling the same failing CI would just burn iterations up to
  // maxIterations. The flow must block on the worker's own reason instead (mirrors ci-fix.ts).
  const gh = fakeGithub({ checks: ['throw-cifailed'], threads: [[]] });
  const { runCmd, commands } = recordingRunCmd();
  const input = baseInput(gh.github, {
    runCmd,
    maxIterations: 5,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      credentials: dummyCredentials,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runWorkerOverride: async () =>
        ({ kind: 'no-changes', reason: 'nothing to change' }) satisfies WorkerResult,
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /nothing to change/);
    // Blocked on the first pass — never looped toward maxIterations burning coding-tier passes.
    assert.equal(result.iterations, 0);
  }
  assert.ok(
    !commands.some((c) => c.includes('push')),
    `no force-push of zero commits, got: ${commands.join(' | ')}`,
  );
  assert.equal(gh.calls.filter((c) => c.method === 'mergePr').length, 0, 'never merges');
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
        credentials: fakeCredentials(stalling),
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
      credentials: dummyCredentials,
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

test('runTakeOverFlow: threads the run signal into the CI-fix Worker input', async () => {
  // The flow's own signal check only fires between iterations; WorkerInput.signal is what stops the
  // editor fanout already in flight when the abort lands.
  const controller = new AbortController();
  const gh = fakeGithub({ checks: ['throw-cifailed'], threads: [[]] });
  let captured: WorkerInput | null = null;
  await runTakeOverFlow(
    baseInput(gh.github, {
      signal: controller.signal,
      subagents: {
        reviewerModel: dummyModel,
        reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
        credentials: dummyCredentials,
        workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
        styleContents: '',
        runWorkerOverride: async (win) => {
          captured = win;
          return { kind: 'blocked', reason: 'stop here' } satisfies WorkerResult;
        },
      },
    }),
  );
  assert.ok(captured, 'CI-fix worker was invoked');
  assert.equal((captured as WorkerInput).signal, controller.signal);
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
    // Always green CI, but the thread never gets recorded as addressed (empty resolutions below) —
    // the addressed-thread dedup only drops a thread once the Reviewer actually reports handling it,
    // so an empty pass leaves it fresh forever. Flow should bail with a max-iterations message.
    checks: ['success'],
    threads: [threads],
  });
  const input = baseInput(gh.github, {
    maxIterations: 2,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      credentials: dummyCredentials,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      // Reports no resolutions at all — nothing to record as addressed, nothing to push — so the
      // thread stays fresh and the loop keeps re-polling it until maxIterations.
      runReviewerOverride: async () => ({ kind: 'ok', resolutions: [] }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /unresolved thread/i);
    assert.equal(result.iterations, 2);
  }
});

test('runTakeOverFlow: budget exceeded before the first iteration → blocked, no CI poll', async () => {
  const gh = fakeGithub({ checks: ['success'], threads: [[]] });
  const result = await runTakeOverFlow(
    baseInput(gh.github, {
      budget: async () => ({
        exceeded: true,
        reason: 'cost ceiling reached ($5.0000 ≥ maxCostUsd $5)',
      }),
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /cost ceiling reached/);
    assert.equal(result.iterations, 0);
  }
  // Blocked before any GitHub call — the ceiling is consulted before this iteration's work starts.
  assert.deepEqual(gh.calls, []);
});

test('runTakeOverFlow: budget exceeded only on a later iteration → runs the earlier ones, then blocks', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_B',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_B', body: 'fix', author: 'rabbit' }],
    },
  ];
  const gh = fakeGithub({ checks: ['success', 'success'], threads: [threads, threads] });
  let calls = 0;
  const input = baseInput(gh.github, {
    budget: async () => {
      calls++;
      return calls > 1 ? { exceeded: true, reason: 'token ceiling reached' } : { exceeded: false };
    },
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      credentials: dummyCredentials,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => ({
        kind: 'ok',
        resolutions: [{ threadId: 'TH_B', kind: 'fixed', commitSha: 'abc' }],
      }),
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /token ceiling reached/);
    // Blocked at the top of the second iteration — before it polled CI or read threads again.
    assert.equal(result.iterations, 1);
  }
  assert.equal(calls, 2);
});

test('runTakeOverFlow: signal aborts during the budget check → cancelled, not blocked', async () => {
  const gh = fakeGithub({ checks: ['success'], threads: [[]] });
  const controller = new AbortController();
  const result = await runTakeOverFlow(
    baseInput(gh.github, {
      signal: controller.signal,
      budget: async () => {
        controller.abort();
        return { exceeded: true, reason: 'should not surface' };
      },
    }),
  );
  assert.equal(result.kind, 'cancelled');
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
  // CI green but threads present → iteration 0 runs the Reviewer, pushes, then sleeps the cooldown.
  // That sleep aborts, so iteration 1's top-of-loop check bails to `cancelled` before any merge.
  // Only the cooldown aborts (the review grace runs first and must not, or the Reviewer never runs).
  const gh = fakeGithub({ checks: ['success'], threads: [threads, []] });
  const controller = new AbortController();
  const input = baseInput(gh.github, {
    signal: controller.signal,
    cooldownMs: 1,
    sleep: async (ms) => {
      if (ms === 1) controller.abort();
    },
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      credentials: dummyCredentials,
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

test('runTakeOverFlow: abort during the CI poll → cancelled before the Reviewer runs', async () => {
  const threads: ReviewThread[] = [
    {
      id: 'TH_P',
      isResolved: false,
      path: 'src/a.ts',
      comments: [{ id: 'C_P', body: 'fix', author: 'rabbit' }],
    },
  ];
  const gh = fakeGithub({ checks: ['success'], threads: [threads, []] });
  const controller = new AbortController();
  const seen: Array<AbortSignal | undefined> = [];
  let reviewerRuns = 0;
  // A cancelled poll returns 'pending' — no verdict. Without the post-poll signal check the flow
  // would read that as "CI not green", download logs and run the fix Worker on a stopped run.
  const github: TakeOverGithub = {
    ...gh.github,
    waitForChecks: async (_pr, signal) => {
      seen.push(signal);
      controller.abort();
      return { state: 'pending', failedChecks: [] };
    },
  };
  const input = baseInput(github, {
    signal: controller.signal,
    subagents: {
      reviewerModel: dummyModel,
      reviewerTools: {} as TakeOverFlowInput['subagents']['reviewerTools'],
      credentials: dummyCredentials,
      workerTools: {} as TakeOverFlowInput['subagents']['workerTools'],
      styleContents: '',
      runReviewerOverride: async () => {
        reviewerRuns += 1;
        return { kind: 'ok', resolutions: [] } satisfies ReviewerResult;
      },
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'cancelled');
  if (result.kind === 'cancelled') assert.equal(result.iterations, 0);
  assert.equal(seen[0], controller.signal, 'the run signal reaches the CI poll');
  assert.equal(reviewerRuns, 0, 'no Reviewer pass on a cancelled run');
  assert.deepEqual(gh.calls, [], 'no thread read, no merge after the cancelled poll');
});

test('runTakeOverFlow: abort during the review grace → cancelled before reading threads', async () => {
  const gh = fakeGithub({ checks: ['success'], threads: [[]] });
  const controller = new AbortController();
  const graceSignals: Array<AbortSignal | undefined> = [];
  const input = baseInput(gh.github, {
    signal: controller.signal,
    sleep: async (ms, signal) => {
      graceSignals.push(signal);
      if (ms === REVIEW_COMMENTS_GRACE) controller.abort();
    },
  });
  const result = await runTakeOverFlow(input);
  assert.equal(result.kind, 'cancelled');
  assert.equal(graceSignals[0], controller.signal, 'the grace sleep is cancellable');
  assert.deepEqual(
    gh.calls.map((c) => c.method),
    ['waitForChecks'],
    'the grace aborted → threads never read, PR never merged',
  );
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
      credentials: dummyCredentials,
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
      credentials: dummyCredentials,
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
      credentials: dummyCredentials,
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
      credentials: dummyCredentials,
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
      credentials: dummyCredentials,
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

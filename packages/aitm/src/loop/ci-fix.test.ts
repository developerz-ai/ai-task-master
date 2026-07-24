import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SubagentHandle } from '@developerz.ai/ai-claude-compat';
import { MockLanguageModelV3 } from 'ai/test';
import type { CompactorLike } from '../compaction/compaction-step.ts';
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
  MAX_CONFLICT_RESOLVE_ATTEMPTS,
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
    credentials: { modelForCapability: () => dummyModel, modelIdForCapability: () => 'test/model' },
    workerTools: {} as WorkerTools,
    styleContents: '',
    runWorkerOverride: async () => okWorker(),
    ...overrides,
  };
}

function stubHandle(marker: string): SubagentHandle<WorkerTools> {
  return { agent: {} as never, messages: [{ role: 'user', content: marker }] };
}

function okWorker(handle: SubagentHandle<WorkerTools> = stubHandle('worker-handle')): WorkerResult {
  return {
    kind: 'ok',
    delivery: {
      branch: 'aitm/core',
      draftCommitMessage: 'fix: green CI',
      changes: [{ path: 'src/a.ts', kind: 'modify', summary: 'fixed assertion' }],
      progressEntries: ['- fix CI'],
    },
    handle,
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
    checkoutPath: '/tmp/wt',
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

test('runFixSession: threads compaction into the real CI-fix worker when a compactor is set (issue #102)', async () => {
  // No runWorkerOverride → the real worker agent is built. buildCompactionStep is invoked only when
  // a compactor is present, and it (and nothing else on this path) queries the coding-tier id — so
  // observing modelIdForCapability('coding') proves the CI-fix worker received compaction wiring.
  const capsSeen: string[] = [];
  const emptyManifestModel = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'submit-0',
          toolName: 'submit',
          input: JSON.stringify({ files: [], draftCommitMessage: 'noop' }),
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
  const stubCompactor: CompactorLike = {
    shouldCompact: async () => ({ kind: 'skip' }),
    compact: async () => '',
  };

  const result = await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      subagents: {
        credentials: {
          modelForCapability: () => emptyManifestModel,
          modelIdForCapability: (cap) => {
            capsSeen.push(cap);
            return 'openai/gpt-5';
          },
        },
        workerTools: {} as WorkerTools,
        styleContents: '',
        compactor: stubCompactor,
      },
    }),
  );

  // Empty manifest → the worker blocks (nothing to commit), which is fine; we only assert wiring.
  assert.equal(result.kind, 'blocked');
  assert.ok(capsSeen.includes('coding'), 'buildCompactionStep queried the coding-tier model id');
});

test('runFixSession: threads timeout into the real CI-fix Worker → a stalled step blocks the session (issue #129)', async () => {
  // No runWorkerOverride → the real Worker agent is built with the forwarded per-step deadline. A
  // stalled coding model is aborted at { stepMs: 40 } and surfaces as the session's blocked reason.
  const stalling = new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
  const result = await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      subagents: {
        credentials: {
          modelForCapability: () => stalling,
          modelIdForCapability: () => 'test/model',
        },
        workerTools: {} as WorkerTools,
        styleContents: '',
        timeout: { stepMs: 40 },
      },
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /exceeded the configured deadline/);
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

test('runFixSession: threads the run signal into the fix Worker input (editor fanout cancel)', async () => {
  // The agent already gets this signal via SubagentInit; the editor fanout is reachable only
  // through WorkerInput.signal, so an abort must land on both or the leaves outlive the run.
  const controller = new AbortController();
  let captured: WorkerInput | null = null;
  await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      signal: controller.signal,
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.ok(captured, 'fix Worker was invoked');
  assert.equal((captured as WorkerInput).signal, controller.signal);
});

test('runFixSession: threads the live rolling context into the fix Worker input (issue #123)', async () => {
  let captured: WorkerInput | null = null;
  const rolling =
    'PR #1 — Auth (group auth, branch aitm/auth)\n- create src/user.ts: adds User model';
  const result = await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      subagents: baseSubagents({
        rollingContext: rolling,
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.equal(result.kind, 'fixed');
  assert.equal(
    (captured as WorkerInput).rollingContext,
    rolling,
    'fix Worker sees what earlier groups shipped',
  );
});

test('runFixSession: an unset rolling context falls back to empty (prior behavior)', async () => {
  let captured: WorkerInput | null = null;
  await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.equal((captured as WorkerInput).rollingContext, '', 'defaults to empty when omitted');
});

test('runFixSession: threads a prior handle into the fix Worker and returns the updated handle (issue #107)', async () => {
  let captured: WorkerInput | null = null;
  const priorHandle = stubHandle('PRIOR-CONVERSATION');
  const nextHandle = stubHandle('AFTER-THIS-PASS');
  const result = await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      priorHandle,
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker(nextHandle);
        },
      }),
    }),
  );
  assert.equal(result.kind, 'fixed');
  if (result.kind === 'fixed') {
    assert.strictEqual(
      result.handle,
      nextHandle,
      "the session carries out the Worker's new handle",
    );
  }
  assert.strictEqual(
    (captured as WorkerInput | null)?.priorHandle,
    priorHandle,
    'the prior handle was continued by the fix Worker',
  );
});

test('runFixSession: without a prior handle the fix Worker cold-starts (issue #107)', async () => {
  let captured: WorkerInput | null = null;
  const result = await runFixSession(
    baseInput({
      runCmd: recordingRunCmd().runCmd,
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.equal(result.kind, 'fixed');
  assert.equal(
    (captured as WorkerInput | null)?.priorHandle,
    undefined,
    'no prior handle threaded',
  );
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

// Scripts a rebase that conflicts once, then reports the given unmerged files until they clear, then
// lets `git rebase --continue` succeed. `resolvedAfter` controls how many conflicted-path polls
// return files before they go empty (simulating the resolver having staged them).
function conflictThenResolvePlan(opts: {
  unmerged: string[];
  // Number of `git diff --diff-filter=U` calls that still report unmerged before it clears.
  clearAfter: number;
}): { plan: (args: readonly string[]) => Partial<RunCmdResult>; diffCalls: () => number } {
  let diff = 0;
  const plan = (args: readonly string[]): Partial<RunCmdResult> => {
    if (args[0] === 'rebase' && args[1]?.startsWith('origin/')) {
      return { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/a.ts' };
    }
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
      diff++;
      return diff <= opts.clearAfter ? { stdout: opts.unmerged.join('\n') } : { stdout: '' };
    }
    // rebase --continue, rebase --abort, fetch, push all succeed by default.
    return {};
  };
  return { plan, diffCalls: () => diff };
}

test('rebaseAndForcePush: conflict + resolver resolves → continue + force-push, returns fixed', async () => {
  const { plan } = conflictThenResolvePlan({ unmerged: ['src/a.ts'], clearAfter: 1 });
  const { runCmd, commands } = recordingRunCmd(plan);
  const seen: Array<{ files: readonly string[]; attempt: number }> = [];
  const resolver = async (input: {
    conflictedFiles: readonly string[];
    attempt: number;
  }): Promise<{ kind: 'resolved' }> => {
    seen.push({ files: input.conflictedFiles, attempt: input.attempt });
    return { kind: 'resolved' };
  };
  const result = await rebaseAndForcePush(runCmd, '/tmp/wt', 'main', 9, undefined, true, resolver);
  assert.equal(result.kind, 'fixed');
  assert.deepEqual(seen, [{ files: ['src/a.ts'], attempt: 1 }], 'resolver saw the unmerged file');
  assert.ok(
    commands.includes('git -c core.editor=true rebase --continue'),
    'drives the rebase forward without opening an editor',
  );
  assert.ok(commands.includes('git push --force-with-lease'), 'force-pushes after resolving');
  assert.ok(!commands.includes('git rebase --abort'), 'never aborts a resolved rebase');
});

test('rebaseAndForcePush: resolver gives up → abort + block, never pushes', async () => {
  const { plan } = conflictThenResolvePlan({ unmerged: ['src/a.ts'], clearAfter: 5 });
  const { runCmd, commands } = recordingRunCmd(plan);
  const result = await rebaseAndForcePush(
    runCmd,
    '/tmp/wt',
    'main',
    9,
    undefined,
    true,
    async () => ({ kind: 'unresolved', reason: 'markers too tangled' }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked')
    assert.match(result.reason, /could not resolve.*markers too tangled/i);
  assert.ok(commands.includes('git rebase --abort'));
  assert.ok(!commands.some((c) => c.includes('push')));
});

test('rebaseAndForcePush: resolver keeps leaving files unmerged → cap exhausts → abort + block', async () => {
  // Files never clear, so each attempt re-checks unmerged, finds them, and retries until the cap.
  const { plan } = conflictThenResolvePlan({ unmerged: ['src/a.ts'], clearAfter: 100 });
  const { runCmd, commands } = recordingRunCmd(plan);
  let calls = 0;
  const result = await rebaseAndForcePush(
    runCmd,
    '/tmp/wt',
    'main',
    9,
    undefined,
    true,
    async () => {
      calls++;
      return { kind: 'resolved' };
    },
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /after 2 AI resolution attempt/i);
  assert.equal(calls, MAX_CONFLICT_RESOLVE_ATTEMPTS, 'resolver invoked exactly the cap');
  assert.ok(commands.includes('git rebase --abort'));
  assert.ok(!commands.some((c) => c.includes('push')));
});

test('rebaseAndForcePush: cancelled run → no further AI resolution, rebase aborted', async () => {
  // The first resolver pass cancels the run (a SIGINT lands mid-resolution). The next attempt must
  // not start — and the half-applied rebase must not be left in the operator's checkout.
  const { plan } = conflictThenResolvePlan({ unmerged: ['src/a.ts'], clearAfter: 100 });
  const { runCmd, commands } = recordingRunCmd(plan);
  const controller = new AbortController();
  let calls = 0;
  const result = await rebaseAndForcePush(
    runCmd,
    '/tmp/wt',
    'main',
    9,
    undefined,
    true,
    async () => {
      calls++;
      controller.abort();
      return { kind: 'resolved' };
    },
    controller.signal,
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /run cancelled/i);
  assert.equal(calls, 1, 'the cap is not spent on a cancelled run');
  assert.ok(commands.includes('git rebase --abort'), 'never leaves the checkout mid-rebase');
  assert.ok(!commands.some((c) => c.includes('push')));
});

test('rebaseAndForcePush: an already-aborted signal → blocks without calling the resolver', async () => {
  const { plan } = conflictThenResolvePlan({ unmerged: ['src/a.ts'], clearAfter: 1 });
  const { runCmd } = recordingRunCmd(plan);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await rebaseAndForcePush(
    runCmd,
    '/tmp/wt',
    'main',
    9,
    undefined,
    true,
    async () => {
      calls++;
      return { kind: 'resolved' };
    },
    controller.signal,
  );
  assert.equal(result.kind, 'blocked');
  assert.equal(calls, 0, 'no AI call once the run is cancelled');
});

test('rebaseAndForcePush: no resolver wired → today’s abort + block (unchanged)', async () => {
  const { runCmd, commands } = recordingRunCmd((args) =>
    args[0] === 'rebase' && args[1]?.startsWith('origin/')
      ? { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/a.ts' }
      : {},
  );
  const result = await rebaseAndForcePush(runCmd, '/tmp/wt', 'main', 9, undefined, true, undefined);
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /manual resolution/i);
  assert.ok(commands.includes('git rebase --abort'));
  assert.ok(!commands.some((c) => c.includes('push')));
  // Resolver absent → the conflicted-paths probe is never even run.
  assert.ok(!commands.some((c) => c.includes('--diff-filter=U')));
});

test('runFixSession: conflict + resolver on subagents → resolves and force-pushes (fixed)', async () => {
  const { plan } = conflictThenResolvePlan({ unmerged: ['src/a.ts'], clearAfter: 1 });
  const { runCmd, commands } = recordingRunCmd(plan);
  const result = await runFixSession(
    baseInput({
      runCmd,
      subagents: baseSubagents({
        resolveConflicts: async () => ({ kind: 'resolved' }),
      }),
    }),
  );
  assert.equal(result.kind, 'fixed');
  assert.ok(commands.includes('git -c core.editor=true rebase --continue'));
  assert.ok(commands.includes('git push --force-with-lease'));
});

test('runFixSession: threads the run signal into the shared push path', async () => {
  // The session's signal must reach rebaseAndForcePush, or a cancelled run still spends AI
  // conflict-resolution passes on its way to a force-push.
  const { plan } = conflictThenResolvePlan({ unmerged: ['src/a.ts'], clearAfter: 1 });
  const { runCmd, commands } = recordingRunCmd(plan);
  const controller = new AbortController();
  controller.abort();
  let resolverCalls = 0;
  const result = await runFixSession(
    baseInput({
      runCmd,
      signal: controller.signal,
      subagents: baseSubagents({
        resolveConflicts: async () => {
          resolverCalls++;
          return { kind: 'resolved' };
        },
      }),
    }),
  );
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') assert.match(result.reason, /run cancelled/i);
  assert.equal(resolverCalls, 0);
  assert.ok(commands.includes('git rebase --abort'), 'reached the push path and cleaned up');
  assert.ok(!commands.includes('git push --force-with-lease'));
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
          modelIdForCapability: () => 'test/model',
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

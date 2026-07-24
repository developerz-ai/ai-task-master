import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { RunCmd, RunCmdResult } from '../github/github-client.ts';
import type { PrGroup } from '../state/schema.ts';
import type { FileManifest, WorkerInput, WorkerResult, WorkerTools } from '../subagents/worker.ts';
import {
  runSelfReviewSession,
  SELF_REVIEW_SYSTEM_PREFIX,
  type SelfReviewInput,
  type SelfReviewSubagents,
} from './self-review.ts';

const dummyModel = new MockLanguageModelV3();

// Records every shell invocation as a flat "file arg arg" string; `plan` decides each result so a
// test can script a failing verify without spawning a process.
function recordingRunCmd(plan: (args: readonly string[]) => Partial<RunCmdResult> = () => ({})): {
  runCmd: RunCmd;
  commands: string[];
  cwds: Array<string | undefined>;
} {
  const commands: string[] = [];
  const cwds: Array<string | undefined> = [];
  const runCmd: RunCmd = async (file, args, options) => {
    commands.push([file, ...args].join(' '));
    cwds.push(options?.cwd);
    const out = plan(args);
    return { stdout: out.stdout ?? '', stderr: out.stderr ?? '', exitCode: out.exitCode ?? 0 };
  };
  return { runCmd, commands, cwds };
}

function baseGroup(overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id: 'core',
    title: 'Core features',
    tasks: [{ id: 'core-1', text: 'do the thing', complexity: 'normal', done: false }],
    dependsOn: [],
    branch: 'aitm/core',
    pr: null,
    status: 'in-progress',
    stage: 'pr-open',
    ...overrides,
  };
}

function okWorker(): WorkerResult {
  return {
    kind: 'ok',
    delivery: {
      branch: 'aitm/core',
      draftCommitMessage: 'fix: address self-review',
      changes: [{ path: 'src/a.ts', kind: 'modify', summary: 'guarded null deref' }],
      progressEntries: ['- self-review'],
    },
    handle: { agent: {} as never, messages: [] },
  };
}

function baseSubagents(overrides: Partial<SelfReviewSubagents> = {}): SelfReviewSubagents {
  return {
    credentials: { modelForCapability: () => dummyModel, modelIdForCapability: () => 'test/model' },
    workerTools: {} as WorkerTools,
    styleContents: '',
    runWorkerOverride: async () => okWorker(),
    ...overrides,
  };
}

function baseInput(overrides: Partial<SelfReviewInput> = {}): SelfReviewInput {
  return {
    subagents: baseSubagents(),
    group: baseGroup(),
    baseBranch: 'main',
    checkoutPath: '/tmp/wt',
    runCmd: recordingRunCmd().runCmd,
    ...overrides,
  };
}

// Emits a single submit tool-call carrying `manifest`; an empty manifest drives runWorker to its
// "blocked: empty manifest" path — the CLEAN case for a review — without running an editor or git.
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

test('SELF_REVIEW_SYSTEM_PREFIX is the adversarial pre-PR self-reviewer prompt (§2e)', () => {
  assert.match(SELF_REVIEW_SYSTEM_PREFIX, /pre-PR self-reviewer/);
  assert.match(SELF_REVIEW_SYSTEM_PREFIX, /hostile reviewer/);
  assert.match(SELF_REVIEW_SYSTEM_PREFIX, /you own this gate/);
  // The four-pass adversarial checklist (correctness / scope / contract / style).
  assert.match(SELF_REVIEW_SYSTEM_PREFIX, /1\. Correctness/);
  assert.match(SELF_REVIEW_SYSTEM_PREFIX, /2\. Scope/);
  assert.match(SELF_REVIEW_SYSTEM_PREFIX, /3\. Contract/);
  assert.match(SELF_REVIEW_SYSTEM_PREFIX, /4\. Style/);
  // Faithful-reporting reinforcement: never claim green without a tool result.
  assert.match(SELF_REVIEW_SYSTEM_PREFIX, /Do NOT claim green/);
});

test('runSelfReviewSession: no verify command → adversarial-review task, Worker fixes → reviewed', async () => {
  let captured: WorkerInput | null = null;
  const { runCmd, commands } = recordingRunCmd();
  const result = await runSelfReviewSession(
    baseInput({
      runCmd,
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.equal(result.kind, 'reviewed');
  assert.deepEqual(commands, [], 'no verifyCommand → no shell verify run');
  assert.ok(captured, 'review Worker was invoked');
  const task = (captured as WorkerInput).task;
  assert.ok(task);
  assert.match(task.text, /adversarially self-review/i);
  assert.match(task.text, /git diff main\.\.\.HEAD/);
  // Verification is coordinator-owned — the Worker must NOT run its own verify gate.
  assert.equal((captured as WorkerInput).verifyCommand, undefined);
});

test('runSelfReviewSession: threads the run signal into the review Worker input', async () => {
  // Mirrors the CI-fix session: the agent's own signal never reaches the editor fanout, which is
  // wired only from WorkerInput.signal.
  const controller = new AbortController();
  let captured: WorkerInput | null = null;
  await runSelfReviewSession(
    baseInput({
      signal: controller.signal,
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.ok(captured, 'review Worker was invoked');
  assert.equal((captured as WorkerInput).signal, controller.signal);
});

test('runSelfReviewSession: nothing to fix (empty manifest, verify clean) → clean', async () => {
  const result = await runSelfReviewSession(
    baseInput({
      subagents: baseSubagents({
        runWorkerOverride: async () => ({ kind: 'blocked', reason: 'empty manifest' }),
      }),
    }),
  );
  assert.equal(result.kind, 'clean');
});

test('runSelfReviewSession: runs the verify command once in the checkout via sh -c', async () => {
  const { runCmd, commands, cwds } = recordingRunCmd();
  await runSelfReviewSession(baseInput({ runCmd, verifyCommand: 'bun test' }));
  assert.equal(commands.length, 1, 'verify runs exactly once (single pass)');
  assert.equal(commands[0], 'sh -c bun test');
  assert.equal(cwds[0], '/tmp/wt', 'verify runs in the checkout');
});

test('runSelfReviewSession: verify fails → fix task carries the tail, and a fixing Worker → reviewed', async () => {
  let captured: WorkerInput | null = null;
  const { runCmd } = recordingRunCmd((args) =>
    args[0] === '-c' ? { exitCode: 1, stdout: 'error TS2532: Object is possibly undefined' } : {},
  );
  const result = await runSelfReviewSession(
    baseInput({
      runCmd,
      verifyCommand: 'bun run typecheck',
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.equal(result.kind, 'reviewed');
  const task = (captured as WorkerInput | null)?.task;
  assert.ok(task);
  assert.match(task.text, /bun run typecheck/);
  assert.match(task.text, /error TS2532/);
  assert.match(task.text, /pre-existing/i, 'instructs the Worker not to hand-wave the failure');
});

test('runSelfReviewSession: verify fails and Worker cannot fix → unclean, PR opens anyway', async () => {
  const { runCmd } = recordingRunCmd((args) =>
    args[0] === '-c' ? { exitCode: 2, stderr: 'FAIL 3 tests' } : {},
  );
  const result = await runSelfReviewSession(
    baseInput({
      runCmd,
      verifyCommand: 'bun test',
      subagents: baseSubagents({
        runWorkerOverride: async () => ({ kind: 'blocked', reason: 'could not plan a fix' }),
      }),
    }),
  );
  assert.equal(result.kind, 'unclean');
  if (result.kind === 'unclean') {
    assert.match(result.reason, /bun test/);
    assert.match(result.reason, /FAIL 3 tests/);
    assert.match(result.reason, /exit 2/);
  }
});

test('runSelfReviewSession: verify command-not-found (exit 127) is inconclusive → clean, no fix task pressure', async () => {
  let captured: WorkerInput | null = null;
  const { runCmd } = recordingRunCmd((args) =>
    args[0] === '-c' ? { exitCode: 127, stderr: 'sh: tsc: not found' } : {},
  );
  const result = await runSelfReviewSession(
    baseInput({
      runCmd,
      verifyCommand: 'tsc --noEmit',
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return { kind: 'blocked', reason: 'empty manifest' };
        },
      }),
    }),
  );
  // 127 must NOT be treated as a real failure: a blocked Worker then reads as clean, and the task
  // never carries a verify-failure section.
  assert.equal(result.kind, 'clean');
  const task = (captured as WorkerInput | null)?.task;
  assert.ok(task);
  assert.doesNotMatch(task.text, /FAILS on these changes/);
});

test('runSelfReviewSession: builds the review Worker on the coding-capability model (no hardcoded tier)', async () => {
  const caps: string[] = [];
  const result = await runSelfReviewSession(
    baseInput({
      subagents: {
        credentials: {
          modelForCapability: (cap) => {
            caps.push(cap);
            // Empty manifest → runWorker blocks before any editor/commit; we only assert the tier.
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
  assert.equal(result.kind, 'clean'); // empty manifest = nothing to fix
});

test("runSelfReviewSession: the group's acceptance check lands in the review task", async () => {
  // SELF_REVIEW_SYSTEM_PREFIX step 3 asks whether the diff meets the task's acceptance check; this
  // is the only path that supplies it, so without it the pass judges a contract it never saw.
  let captured: WorkerInput | null = null;
  await runSelfReviewSession(
    baseInput({
      group: baseGroup({
        acceptance: 'bun test src/core passes and `aitm --version` prints 1.2.3',
      }),
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  const task = (captured as WorkerInput | null)?.task;
  assert.ok(task);
  assert.match(task.text, /## Acceptance check for this PR group/);
  assert.match(task.text, /bun test src\/core passes/);
  assert.match(task.text, /never report it as holding on reasoning alone/);
});

test('runSelfReviewSession: a group without an acceptance check leaves the task text unchanged', async () => {
  let captured: WorkerInput | null = null;
  await runSelfReviewSession(
    baseInput({
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  const task = (captured as WorkerInput | null)?.task;
  assert.ok(task);
  assert.doesNotMatch(task.text, /Acceptance check/);
});

test("self-review checks the diff against the group's planned work (the missing-routes case)", async () => {
  // A phantom edit once shipped a PR with its services and no routes: the coding pass narrated the
  // file instead of writing it, and self-review passed the diff because it only ever looked at the
  // diff. Reviewing against intent is what catches work that was planned and never landed.
  let captured: WorkerInput | null = null;
  await runSelfReviewSession(
    baseInput({
      group: baseGroup({
        tasks: [
          {
            id: 'g-1',
            text: 'Add the todo repository and services',
            complexity: 'normal',
            done: true,
          },
          {
            id: 'g-2',
            text: 'Add POST /todos and DELETE /todos/:id routes',
            complexity: 'normal',
            done: true,
          },
        ],
      }),
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  const text = captured?.task?.text ?? '';
  assert.match(text, /Planned for this group:/);
  assert.match(text, /- Add POST \/todos and DELETE \/todos\/:id routes/);
  assert.match(text, /planned\s+and is missing is a defect/);
  // Facts only — the checklist must not invite the reviewer to trust the coding pass's reasoning.
  assert.doesNotMatch(text, /the implementer (?:said|believed|reported)/i);
});

test('self-review: a group with no task text adds no planned-work block', async () => {
  let captured: WorkerInput | null = null;
  await runSelfReviewSession(
    baseInput({
      group: baseGroup({ tasks: [] }),
      subagents: baseSubagents({
        runWorkerOverride: async (input) => {
          captured = input;
          return okWorker();
        },
      }),
    }),
  );
  assert.doesNotMatch(captured?.task?.text ?? '', /Planned for this group/);
});

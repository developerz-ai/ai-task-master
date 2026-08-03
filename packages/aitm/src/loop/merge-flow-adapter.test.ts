// Unit coverage for the production merge-pr wiring (moved out of cli/commands.ts's
// `defaultRunMergeFlow` — CLAUDE.md scopes the CLI module to arg-parsing + exit codes).
//
// `maxIterations: 0` skips runTakeOverFlow's loop body entirely (no subagents, no rebase/push),
// landing straight on its post-loop final-state check — the same three-way result mapping
// (merged/blocked/cancelled) exercised without needing a real model or git checkout.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LanguageModelUsage } from 'ai';
import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import type { RunMergeFlowInput } from '../composition/run-input.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import { Credentials } from '../credentials/credentials.ts';
import { DEFAULT_MODELS } from '../domain/model.ts';
import {
  GitHubClient,
  type RunCmd,
  type RunCmdResult,
  type Sleep,
} from '../github/github-client.ts';
import { UsageTracker } from '../observability/usage-tracker.ts';
import type { ModelLimits, ModelLimitsLookup } from '../openrouter/model-limits.ts';
import type { RunState } from '../state/schema.ts';
import { CURRENT_SCHEMA_VERSION } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import { modelUsage } from '../testing/model-fixtures.ts';
import { type MergeFlowSeams, mergeFlowAdapter } from './merge-flow-adapter.ts';
import type { TakeOverFlowInput, TakeOverResult } from './take-over-flow.ts';

type Reply = Partial<RunCmdResult>;

// Dispatches on the gh/git args shape rather than call order, so the fixed sequence
// (defaultBranch → [loop skipped] → waitForChecks → listUnresolvedThreads → mergePr) stays
// readable without hardcoding positions.
function fakeRunCmd(scripted: { checksBucket: 'pass' | 'fail'; mergeExitCode?: number }): {
  run: RunCmd;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: RunCmd = async (file, args) => {
    calls.push([file, ...args]);
    const reply = ((): Reply => {
      if (
        file === 'gh' &&
        args[0] === 'repo' &&
        args[2] === '--json' &&
        args[3] === 'defaultBranchRef'
      ) {
        return { stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }) };
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'checks') {
        return {
          stdout: JSON.stringify([
            { bucket: scripted.checksBucket, name: 'ci', state: scripted.checksBucket },
          ]),
        };
      }
      if (file === 'gh' && args[0] === 'repo' && args[2] === '--json' && args[3] === 'owner,name') {
        return { stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }) };
      }
      if (file === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                },
              },
            },
          }),
        };
      }
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
        return { exitCode: scripted.mergeExitCode ?? 0 };
      }
      throw new Error(`unmocked gh call: ${file} ${args.join(' ')}`);
    })();
    return {
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode ?? 0,
    };
  };
  return { run, calls };
}

const noopSleep: Sleep = async () => {};

const baseResolved = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  openrouterApiKey: 'sk-or-test',
  apiKeySource: 'env',
  models: { ...DEFAULT_MODELS },
  maxPrs: 5,
  maxSessions: null,
  maxCiFixAttempts: 3,
  llmStepTimeoutMs: 60_000,
  autoMerge: true,
  prPerTask: false,
  mergeMethod: 'squash',
  adminMerge: false,
  stylePath: null,
  formatCommand: null,
  verifyCommand: null,
  selfReview: true,
  resolveConflicts: false,
  logLevel: 'info',
  concurrency: 1,
  allowForcePush: true,
  bashRules: [],
  mcpServers: {},
  mcpDeferToolsOver: 8,
  mcpServerSources: {},
  reasoningEffort: {},
  ...overrides,
});

const agentConfig: AgentConfig = {
  flavor: 'claude',
  path: 'CLAUDE.md',
  contents: '# style',
  sources: [],
};

function baseRunState(): RunState {
  return {
    status: 'awaiting-pr',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    prGroups: [],
    currentGroupIndex: 0,
    currentTaskIndex: 0,
    sessionCount: 0,
    currentPr: 42,
    runId: 'takeover-1',
    provider: 'openrouter',
    model: 'm',
    agentConfigFile: 'CLAUDE.md',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    options: {
      autoMerge: true,
      prPerTask: false,
      maxPrs: 5,
      maxSessions: null,
      mergeMethod: 'squash',
      stylePath: null,
      concurrency: 1,
    },
  };
}

function baseInput(overrides: Partial<RunMergeFlowInput> = {}): RunMergeFlowInput {
  const resolved = overrides.resolved ?? baseResolved();
  return {
    cwd: '/tmp/repo',
    pr: 42,
    resume: false,
    resolved,
    credentials: new Credentials(resolved),
    agentConfig,
    state: new StateStore('/tmp/aitm-merge-flow-adapter-test-unused'),
    runState: baseRunState(),
    github: new GitHubClient('/tmp/repo'),
    maxIterations: 0,
    ...overrides,
  };
}

test('mergeFlowAdapter: CI green + no threads → merged, mapped to success', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'pass' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const result = await mergeFlowAdapter(baseInput({ github }));
  assert.deepEqual(result, {
    kind: 'success',
    outcomes: [{ groupId: 'takeover-42', status: 'merged', pr: 42 }],
  });
});

test('mergeFlowAdapter: CI red after exhausting iterations → blocked, mapped with reason', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'fail' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const result = await mergeFlowAdapter(baseInput({ github }));
  assert.equal(result.kind, 'blocked');
  assert.match(result.kind === 'blocked' ? result.reason : '', /CI failure/);
  assert.deepEqual(result.outcomes, [
    {
      groupId: 'takeover-42',
      status: 'blocked',
      reason: result.kind === 'blocked' ? result.reason : '',
    },
  ]);
});

test('mergeFlowAdapter: aborted signal → cancelled, mapped with empty outcomes', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'pass' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const controller = new AbortController();
  controller.abort();
  const result = await mergeFlowAdapter(baseInput({ github, signal: controller.signal }));
  assert.deepEqual(result, { kind: 'cancelled', outcomes: [] });
});

// --- parity plumbing: bashRules / ProcessManager / applyHooks / usage (issues #113/#121/#190) ---

// Capture the TakeOverFlowInput the adapter builds — via the runTakeOver seam — so the four parity
// seams can be asserted on the wired subagents without driving the real take-over loop.
function captureFlow(returns: TakeOverResult): {
  seams: MergeFlowSeams;
  captured: () => TakeOverFlowInput;
} {
  let seen: TakeOverFlowInput | undefined;
  return {
    seams: {
      runTakeOver: async (input) => {
        seen = input;
        return returns;
      },
    },
    captured: () => {
      assert.ok(seen, 'runTakeOver seam was invoked');
      return seen;
    },
  };
}

// Drive a tool's execute the way the SDK does — enough of the options object for the tool to run.
async function execTool<O>(t: { execute?: unknown }, input: unknown): Promise<O> {
  const exec = t.execute as (
    i: unknown,
    o: { toolCallId: string; messages: never[] },
  ) => Promise<O>;
  return exec(input, { toolCallId: 'test', messages: [] });
}

// A lookup with no pricing → tokens still record, cost stays null (never touches the network).
const noLimits: ModelLimitsLookup = {
  preload: async () => {},
  forModel: async (modelId): Promise<ModelLimits> => ({ modelId }),
};

function usageOf(input: number, output: number): LanguageModelUsage {
  return modelUsage({ inputTokens: input, outputTokens: output, totalTokens: input + output });
}

test('mergeFlowAdapter: worker tools carry bashRules, the ProcessManager, and operator hooks', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'pass' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const resolved = baseResolved({
    bashRules: [{ pattern: 'git push --force*', action: 'deny' }],
    hooks: { preToolUse: [{ matcher: 'datetime', command: 'exit 2' }] },
  });
  const flow = captureFlow({ kind: 'merged', pr: 42, iterations: 0 });
  // cwd = a real dir so the PreToolUse hook subprocess has somewhere to spawn.
  await mergeFlowAdapter(baseInput({ github, resolved, cwd: process.cwd() }), flow.seams);
  const { subagents } = flow.captured();

  // bashRules (#113): a denied command short-circuits at exit 126 without spawning.
  const denied = await execTool<{ exitCode: number; denied?: boolean }>(
    subagents.workerTools.bash,
    {
      command: 'git push --force',
    },
  );
  assert.equal(denied.exitCode, 126);
  assert.equal(denied.denied, true);

  // ProcessManager (#103): the background poll/stop tools are mounted only when a manager is wired.
  assert.ok(Object.hasOwn(subagents.workerTools, 'bashOutput'), 'bashOutput mounted');
  assert.ok(Object.hasOwn(subagents.workerTools, 'killBash'), 'killBash mounted');

  // applyHooks (#121): the PreToolUse hook blocks the matched tool before it runs.
  const blocked = await execTool<{ blockedByHook?: boolean }>(subagents.workerTools.datetime, {});
  assert.equal(blocked.blockedByHook, true);
});

test('mergeFlowAdapter: a usage tracker → role-scoped worker + reviewer sinks that record spend', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'pass' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const tracker = new UsageTracker(noLimits);
  const flow = captureFlow({ kind: 'merged', pr: 42, iterations: 0 });
  await mergeFlowAdapter(baseInput({ github, usage: tracker }), flow.seams);
  const { subagents } = flow.captured();

  assert.equal(typeof subagents.onWorkerUsage, 'function');
  assert.equal(typeof subagents.onReviewerUsage, 'function');
  subagents.onWorkerUsage?.(usageOf(100, 20), 'coding-model');
  subagents.onReviewerUsage?.(usageOf(10, 5), 'reviewer-model');

  const totals = await tracker.totals();
  assert.equal(totals.perRole.worker?.inputTokens, 100);
  assert.equal(totals.perRole.worker?.outputTokens, 20);
  assert.equal(totals.perRole.reviewer?.inputTokens, 10);
  assert.equal(totals.overall.calls, 2);
});

test('mergeFlowAdapter: no usage tracker → onUsage seams omitted (no accounting)', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'pass' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const flow = captureFlow({ kind: 'merged', pr: 42, iterations: 0 });
  await mergeFlowAdapter(baseInput({ github }), flow.seams);
  const { subagents } = flow.captured();
  assert.equal(subagents.onWorkerUsage, undefined);
  assert.equal(subagents.onReviewerUsage, undefined);
});

// --- run-level cost/token ceiling (issue #190) ---

test('mergeFlowAdapter: a tracker + a configured ceiling → wires a budget check that reports usage', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'pass' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const tracker = new UsageTracker(noLimits);
  const resolved = baseResolved({ maxTotalTokens: 100 });
  const flow = captureFlow({ kind: 'merged', pr: 42, iterations: 0 });
  await mergeFlowAdapter(baseInput({ github, resolved, usage: tracker }), flow.seams);
  const { budget } = flow.captured();

  assert.equal(typeof budget, 'function');
  assert.equal((await budget?.())?.exceeded, false);

  // Same ledger the role-usage sinks feed — recording spend through them trips the ceiling.
  const { subagents } = flow.captured();
  subagents.onWorkerUsage?.(usageOf(80, 30), 'coding-model');
  const status = await budget?.();
  assert.equal(status?.exceeded, true);
  if (status?.exceeded) assert.match(status.reason, /token ceiling reached/);
});

test('mergeFlowAdapter: no ceiling configured → budget seam omitted', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'pass' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const tracker = new UsageTracker(noLimits);
  const flow = captureFlow({ kind: 'merged', pr: 42, iterations: 0 });
  await mergeFlowAdapter(baseInput({ github, usage: tracker }), flow.seams);
  assert.equal(flow.captured().budget, undefined);
});

test('mergeFlowAdapter: a ceiling but no tracker → budget seam omitted (nothing to measure against)', async () => {
  const { run } = fakeRunCmd({ checksBucket: 'pass' });
  const github = new GitHubClient('/tmp/repo', run, noopSleep);
  const resolved = baseResolved({ maxCostUsd: 5 });
  const flow = captureFlow({ kind: 'merged', pr: 42, iterations: 0 });
  await mergeFlowAdapter(baseInput({ github, resolved }), flow.seams);
  assert.equal(flow.captured().budget, undefined);
});

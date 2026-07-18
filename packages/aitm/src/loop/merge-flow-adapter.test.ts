// Unit coverage for the production merge-pr wiring (moved out of cli/commands.ts's
// `defaultRunMergeFlow` — CLAUDE.md scopes the CLI module to arg-parsing + exit codes).
//
// `maxIterations: 0` skips runTakeOverFlow's loop body entirely (no subagents, no rebase/push),
// landing straight on its post-loop final-state check — the same three-way result mapping
// (merged/blocked/cancelled) exercised without needing a real model or git checkout.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import type { RunMergeFlowInput } from '../cli/commands.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import { Credentials } from '../credentials/credentials.ts';
import { DEFAULT_MODELS } from '../credentials/defaults.ts';
import {
  GitHubClient,
  type RunCmd,
  type RunCmdResult,
  type Sleep,
} from '../github/github-client.ts';
import type { RunState } from '../state/schema.ts';
import { StateStore } from '../state/state-store.ts';
import { mergeFlowAdapter } from './merge-flow-adapter.ts';

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

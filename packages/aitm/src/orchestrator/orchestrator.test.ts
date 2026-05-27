import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { Role } from '../credentials/credentials.ts';
import type { CreatePrInput } from '../github/github-client.ts';
import type { PullRequest } from '../github/schema.ts';
import type { PrGroup } from '../state/schema.ts';
import type { GithubToolInput, GithubToolOutput, ReviewerTools } from '../subagents/reviewer.ts';
import type {
  BashInput,
  BashOutput,
  ReadFileInput,
  ReadFileOutput,
  WorkerDelivery,
  WorkerTools,
  WriteFileInput,
  WriteFileOutput,
} from '../subagents/worker.ts';
import {
  DEFAULT_MAX_STEPS,
  type GhClient,
  ORCHESTRATOR_ROLE_PREFIX,
  Orchestrator,
  type OrchestratorBuildContext,
  type RunCmd,
  resolveMaxSteps,
} from './orchestrator.ts';
import type { ModelProvider } from './subagent-tools.ts';

function emptyUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
    totalTokens: 2,
  };
}

function modelEmitting(text: string | (() => string)): MockLanguageModelV3 {
  const fn = typeof text === 'function' ? text : (): string => text;
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: fn() }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
}

function recordingProvider(model: MockLanguageModelV3): {
  provider: ModelProvider;
  roles: Role[];
} {
  const roles: Role[] = [];
  return {
    provider: {
      modelFor(role) {
        roles.push(role);
        return model;
      },
    },
    roles,
  };
}

function workerToolsStub(): WorkerTools {
  return {
    readFile: tool<ReadFileInput, ReadFileOutput>({
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: '' }),
    }),
    writeFile: tool<WriteFileInput, WriteFileOutput>({
      description: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    bash: tool<BashInput, BashOutput>({
      description: 'bash',
      inputSchema: z.object({ command: z.string() }),
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
  };
}

function reviewerToolsStub(): ReviewerTools {
  return {
    ...workerToolsStub(),
    github: tool<GithubToolInput, GithubToolOutput>({
      description: 'github',
      inputSchema: z.discriminatedUnion('action', [
        z.object({ action: z.literal('replyToThread'), threadId: z.string(), body: z.string() }),
        z.object({ action: z.literal('resolveThread'), threadId: z.string() }),
      ]),
      execute: async () => ({ ok: true }),
    }),
  };
}

function baseGroup(): PrGroup {
  return {
    id: 'core',
    title: 'Core',
    tasks: ['task A', 'task B'],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
  };
}

function baseDelivery(): WorkerDelivery {
  return {
    branch: 'aitm/core',
    draftCommitMessage: 'feat: add a',
    changes: [
      { path: 'src/a.ts', kind: 'create', summary: 'created a' },
      { path: 'src/b.ts', kind: 'modify', summary: 'fixed b' },
    ],
    progressEntries: ['- task A', '- task B'],
  };
}

function basePr(headRefName = 'aitm/core'): PullRequest {
  return {
    number: 42,
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/42',
    headRefName,
    baseRefName: 'main',
  };
}

function baseContext(): OrchestratorBuildContext {
  return {
    plannerTools: {},
    workerTools: workerToolsStub(),
    reviewerTools: reviewerToolsStub(),
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
    pr: 0,
    threads: [],
  };
}

test('resolveMaxSteps: positive caller value overrides the default', () => {
  assert.equal(resolveMaxSteps(7), 7);
  assert.equal(resolveMaxSteps(1), 1);
});

test('resolveMaxSteps: null / 0 / negative fall back to DEFAULT_MAX_STEPS', () => {
  assert.equal(resolveMaxSteps(null), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps(0), DEFAULT_MAX_STEPS);
  assert.equal(resolveMaxSteps(-3), DEFAULT_MAX_STEPS);
});

test('Orchestrator is constructible', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSessions: null,
    github: {} as never,
  });
  assert.ok(o instanceof Orchestrator);
});

test('buildSystemPrompt = agentConfig.contents + ORCHESTRATOR_ROLE_PREFIX + rollingContext', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '# repo style' },
    rollingContext: 'prior PRs: 1, 2',
    maxSessions: null,
    github: {} as never,
  });
  const sys = o.buildSystemPrompt();
  assert.ok(sys.includes('# repo style'), 'style payload must be present');
  assert.ok(sys.includes(ORCHESTRATOR_ROLE_PREFIX), 'role prefix must be present');
  assert.ok(sys.includes('prior PRs: 1, 2'), 'rolling context must be present');
  // Ordering: style comes before role prefix, role prefix before rolling context.
  assert.ok(sys.indexOf('# repo style') < sys.indexOf(ORCHESTRATOR_ROLE_PREFIX));
  assert.ok(sys.indexOf(ORCHESTRATOR_ROLE_PREFIX) < sys.indexOf('prior PRs: 1, 2'));
});

test('build composes planner/worker/reviewer tools and resolves orchestrator model', () => {
  const model = new MockLanguageModelV3();
  const { provider, roles } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSessions: null,
    github: {} as never,
  });
  const agent = o.build(baseContext());
  assert.ok(agent);
  assert.deepEqual(Object.keys(agent.tools).sort(), ['planner', 'reviewer', 'worker']);
  // build itself only resolves the orchestrator's own model — subagent role models
  // resolve lazily inside each tool's execute, so we expect a single entry here.
  assert.deepEqual(roles, ['orchestrator']);
});

test('finalizeCommit rewrites commit message and amends via runCmd, returning the new SHA', async () => {
  const refinedMessage = 'feat(core): add module a + fix module b';
  const model = modelEmitting(refinedMessage);
  const { provider } = recordingProvider(model);

  type Call = { file: string; args: readonly string[]; cwd?: string };
  const calls: Call[] = [];
  const runCmd: RunCmd = async (file, args, options) => {
    calls.push({ file, args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
    if (args[0] === 'rev-parse') return { stdout: 'shaXYZ\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSessions: null,
    github: {} as never,
    runCmd,
  });

  const sha = await o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt');
  assert.equal(sha, 'shaXYZ');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    file: 'git',
    args: ['commit', '--amend', '-m', refinedMessage],
    cwd: '/tmp/wt',
  });
  assert.deepEqual(calls[1], {
    file: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: '/tmp/wt',
  });
});

test('finalizeCommit throws when git amend fails', async () => {
  const model = modelEmitting('feat: x');
  const { provider } = recordingProvider(model);
  const runCmd: RunCmd = async () => ({
    stdout: '',
    stderr: 'fatal: nothing to commit',
    exitCode: 1,
  });
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSessions: null,
    github: {} as never,
    runCmd,
  });
  await assert.rejects(
    () => o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt'),
    /git commit --amend failed/,
  );
});

test('openPr composes title + body via the orchestrator model and calls github.createPr', async () => {
  const composition = { title: 'feat: core — add a', body: 'Adds module a; fixes module b.' };
  const model = modelEmitting(JSON.stringify(composition));
  const { provider, roles } = recordingProvider(model);

  const createCalls: CreatePrInput[] = [];
  const github: GhClient = {
    createPr: async (input) => {
      createCalls.push(input);
      return basePr(input.head);
    },
  };

  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: 'prior: nothing yet',
    maxSessions: null,
    github,
  });
  const pr = await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.equal(pr.number, 42);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    title: composition.title,
    body: composition.body,
    base: 'main',
    head: 'aitm/core',
  });
  // Composition uses the orchestrator-tier model handle.
  assert.deepEqual(roles, ['orchestrator']);
});

test('openPr uses group.branch when set, otherwise aitm/<id>', async () => {
  const composition = { title: 't', body: 'b' };
  const model = modelEmitting(JSON.stringify(composition));
  const { provider } = recordingProvider(model);

  const createCalls: CreatePrInput[] = [];
  const github: GhClient = {
    createPr: async (input) => {
      createCalls.push(input);
      return basePr(input.head);
    },
  };

  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSessions: null,
    github,
  });
  const customGroup = { ...baseGroup(), branch: 'feature/custom' };
  await o.openPr(customGroup, baseDelivery(), 'main');
  assert.equal(createCalls[0]?.head, 'feature/custom');
});

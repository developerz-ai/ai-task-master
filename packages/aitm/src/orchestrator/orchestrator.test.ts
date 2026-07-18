import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StepTimeoutError } from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { Role } from '../credentials/credentials.ts';
import type { CreatePrInput } from '../github/github-client.ts';
import type { PullRequest } from '../github/schema.ts';
import type { PrGroup } from '../state/schema.ts';
import type { GithubToolInput, GithubToolOutput, ReviewerTools } from '../subagents/reviewer.ts';
import {
  type BashInput,
  type BashOutput,
  type FileManifest,
  type ReadFileInput,
  type ReadFileOutput,
  WORKER_MAX_STEPS,
  type WorkerDelivery,
  type WorkerTools,
  type WriteFileInput,
  type WriteFileOutput,
} from '../subagents/worker.ts';
import { taskCommitTrailer } from '../workspace/task-commit-marker.ts';
import {
  assertPrBodySections,
  DEFAULT_MAX_STEPS,
  type GhClient,
  ORCHESTRATOR_ROLE_PREFIX,
  Orchestrator,
  type OrchestratorBuildContext,
  PR_BODY_GUIDE,
  PR_BODY_SECTIONS,
  prBodyGuideFor,
  type RunCmd,
  resolveMaxSteps,
  resolvePrBodySections,
} from './orchestrator.ts';
import type { ModelProvider } from './subagent-tools.ts';

// A PR body that satisfies the section contract (assertPrBodySections), reused by openPr tests.
const COMPLIANT_BODY =
  '## Summary\nDid the thing.\n\n## Changes\n- a.ts: added\n\n## Testing\n- ran tests';

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

// A model that only settles by rejecting when its abortSignal fires — proves the direct generateText
// sites arm the per-step deadline (issue #129).
function stallingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
}

// composePr now delivers structured output via a forced `submit` tool-call (not response_format),
// so the mock model emits a submit tool-call carrying the composition (input is a JSON string).
let submitCallId = 0;
function modelSubmitting(value: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: `submit-${submitCallId++}`,
          toolName: 'submit',
          input: JSON.stringify(value),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
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
    tasks: [
      { id: 'task-a', text: 'task A', complexity: 'normal', done: false },
      { id: 'task-b', text: 'task B', complexity: 'normal', done: false },
    ],
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
    checkoutPath: '/tmp/wt',
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

test("build: the Worker subagent tool keeps its own fixed step-budget regardless of the orchestrator's maxSteps (decoupled)", async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/x.ts', kind: 'create', purpose: 'create x' }],
    draftCommitMessage: 'feat: x',
  };
  let sentSystem = '';
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      if (sentSystem === '') sentSystem = JSON.stringify(opts.prompt);
      if (i++ === 0) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'submit-manifest',
              toolName: 'submit',
              input: JSON.stringify(manifest),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: 'created x' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider } = recordingProvider(model);
  // An orchestrator maxSteps wildly different from WORKER_MAX_STEPS — if the two were coupled, the
  // Worker's system prompt would report this number instead of its own fixed budget.
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: 3,
    github: {} as never,
  });
  const agent = o.build(baseContext());
  const workerExec = agent.tools.worker.execute;
  if (typeof workerExec !== 'function') throw new Error('no worker execute');
  await workerExec({}, { toolCallId: 'tc', messages: [] });
  assert.match(sentSystem, new RegExp(`hard budget of ${WORKER_MAX_STEPS} tool steps`));
  assert.doesNotMatch(sentSystem, /hard budget of 3 tool steps/);
});

test('Orchestrator is constructible', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {} as never,
  });
  assert.ok(o instanceof Orchestrator);
});

test('buildSystemPrompt = agentConfig.contents + ORCHESTRATOR_ROLE_PREFIX + rollingContext', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '# repo style' },
    rollingContext: 'prior PRs: 1, 2',
    maxSteps: null,
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

test('buildSystemPrompt: styleDigest replaces agentConfig.contents as the style prefix', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '# raw style' },
    styleDigest: '# distilled digest',
    rollingContext: 'prior PRs: 1',
    maxSteps: null,
    github: {} as never,
  });
  const sys = o.buildSystemPrompt();
  assert.ok(sys.includes('# distilled digest'), 'digest must be used as the style prefix');
  assert.ok(!sys.includes('# raw style'), 'raw contents must be suppressed when digest present');
  assert.ok(sys.includes(ORCHESTRATOR_ROLE_PREFIX), 'role prefix must be present');
  assert.ok(sys.includes('prior PRs: 1'), 'rolling context must be present');
});

test('finalizeCommit sends buildSystemPrompt() via the system field, not duplicated into the user prompt', async () => {
  let captured: unknown;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      captured = opts.prompt;
      return {
        content: [{ type: 'text', text: 'feat: message' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '# repo style' },
    rollingContext: 'prior PRs: 1',
    maxSteps: null,
    github: {} as never,
    runCmd: async (file, args) =>
      args[0] === 'rev-parse'
        ? { stdout: 'deadbeef\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
  });
  await o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt');

  const messages = captured as ReadonlyArray<{ role: string; content: unknown }>;
  const system = messages.find((m) => m.role === 'system');
  const rest = JSON.stringify(messages.filter((m) => m.role !== 'system'));
  assert.ok(system, 'a system message must be present');
  assert.match(JSON.stringify(system), /# repo style/);
  assert.match(JSON.stringify(system), new RegExp(ORCHESTRATOR_ROLE_PREFIX.split('\n')[1] ?? ''));
  // The role prefix (part of buildSystemPrompt) must not be re-concatenated into the user turn.
  assert.doesNotMatch(rest, /Only you spawn; leaves never spawn|## Role: Orchestrator/);
});

test('openPr sends buildSystemPrompt() via the system field, not duplicated into the user prompt', async () => {
  let captured: unknown;
  const composition = { title: 't', body: COMPLIANT_BODY };
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      captured = opts.prompt;
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${submitCallId++}`,
            toolName: 'submit',
            input: JSON.stringify(composition),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '# repo style' },
    rollingContext: 'prior PRs: 1',
    maxSteps: null,
    github: { createPr: async (input) => basePr(input.head) },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');

  const messages = captured as ReadonlyArray<{ role: string; content: unknown }>;
  const system = messages.find((m) => m.role === 'system');
  const rest = JSON.stringify(messages.filter((m) => m.role !== 'system'));
  assert.ok(system, 'a system message must be present');
  assert.match(JSON.stringify(system), /# repo style/);
  assert.doesNotMatch(rest, /## Role: Orchestrator/);
});

test('build composes planner/worker/reviewer/done tools and resolves orchestrator model', () => {
  const model = new MockLanguageModelV3();
  const { provider, roles } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {} as never,
  });
  const agent = o.build(baseContext());
  assert.ok(agent);
  assert.deepEqual(Object.keys(agent.tools).sort(), ['done', 'planner', 'reviewer', 'worker']);
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
    maxSteps: null,
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

test('finalizeCommit stamps a task-id trailer onto the amended message when taskId is given', async () => {
  const refinedMessage = 'feat(core): add module a';
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
    maxSteps: null,
    github: {} as never,
    runCmd,
  });

  await o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt', 'task-a');
  assert.deepEqual(calls[0], {
    file: 'git',
    args: ['commit', '--amend', '-m', `${refinedMessage}\n\n${taskCommitTrailer('task-a')}`],
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
    maxSteps: null,
    github: {} as never,
    runCmd,
  });
  await assert.rejects(
    () => o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt'),
    /git commit --amend failed/,
  );
});

test('finalizeCommit arms the per-step deadline — a stalled refine call surfaces a StepTimeoutError (issue #129)', async () => {
  const { provider } = recordingProvider(stallingModel());
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {} as never,
    runCmd: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    timeout: { stepMs: 40 },
  });
  await assert.rejects(
    () => o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt'),
    (err: unknown) => err instanceof StepTimeoutError,
  );
});

test('openPr arms the per-step deadline — a stalled compose call surfaces a StepTimeoutError (issue #129)', async () => {
  // composePr carries the same callWithStepTimeout wrapping as refineCommitMessage; assert the
  // deadline fires on its generateText too, before github.createPr is ever reached.
  let createPrCalled = false;
  const { provider } = recordingProvider(stallingModel());
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {
      createPr: async () => {
        createPrCalled = true;
        return basePr('aitm/core');
      },
    },
    timeout: { stepMs: 40 },
  });
  await assert.rejects(
    () => o.openPr(baseGroup(), baseDelivery(), 'main'),
    (err: unknown) => err instanceof StepTimeoutError,
  );
  assert.equal(createPrCalled, false, 'the stalled compose aborts before the PR is opened');
});

test('openPr composes title + body via the orchestrator model and calls github.createPr', async () => {
  const composition = { title: 'feat: core — add a', body: COMPLIANT_BODY };
  const model = modelSubmitting(composition);
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
    maxSteps: null,
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

test('composePr requests submit via toolChoice "auto" (thinking-model compat)', async () => {
  // Thinking-enabled models reject a FORCED tool_choice outright — Kimi's coding models answer
  // "tool_choice 'specified'/'required' is incompatible with thinking enabled", blocking PR
  // composition. `submit` is the only tool and the prompt tells the model to call it, so 'auto'
  // yields the single submit call on every model tested. Guard the shape against a regression to a
  // forced choice.
  const composition = { title: 'feat: core — add a', body: COMPLIANT_BODY };
  let seenToolChoice: unknown;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seenToolChoice = options.toolChoice;
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${submitCallId++}`,
            toolName: 'submit',
            input: JSON.stringify(composition),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: 'prior: nothing yet',
    maxSteps: null,
    github: { createPr: async (input) => basePr(input.head) },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.deepEqual(seenToolChoice, { type: 'auto' });
});

test('PR_BODY_GUIDE defines the standard Summary/Changes/Testing sections', () => {
  for (const heading of PR_BODY_SECTIONS) {
    assert.ok(PR_BODY_GUIDE.includes(heading), `expected guide to mention ${heading}`);
  }
});

test('resolvePrBodySections: undefined/empty → default set', () => {
  assert.deepEqual(resolvePrBodySections(undefined), PR_BODY_SECTIONS);
  assert.deepEqual(resolvePrBodySections([]), PR_BODY_SECTIONS);
});

test('resolvePrBodySections: valid custom headings are used verbatim', () => {
  const custom = ['## What', '## Why', '## Changes', '## Verification'];
  assert.deepEqual(resolvePrBodySections(custom), custom);
});

test('resolvePrBodySections: any malformed heading falls back to default', () => {
  assert.deepEqual(resolvePrBodySections(['## What', 'Why']), PR_BODY_SECTIONS);
  assert.deepEqual(resolvePrBodySections(['##NoSpace']), PR_BODY_SECTIONS);
});

test('prBodyGuideFor: default set returns the bespoke guide', () => {
  assert.equal(prBodyGuideFor(PR_BODY_SECTIONS), PR_BODY_GUIDE);
});

test('prBodyGuideFor: custom set lists each heading verbatim', () => {
  const custom = ['## What', '## Why', '## Verification'];
  const guide = prBodyGuideFor(custom);
  for (const heading of custom) assert.ok(guide.includes(heading), `missing ${heading}`);
  assert.ok(guide.includes('3 sections'));
});

test('assertPrBodySections: enforces a custom section set', () => {
  const custom = ['## What', '## Why'];
  assert.doesNotThrow(() => assertPrBodySections('## What\nx\n\n## Why\ny', custom));
  assert.throws(() => assertPrBodySections('## Summary\nx', custom), /What/);
});

test('assertPrBodySections: accepts a body with all sections in order', () => {
  assert.doesNotThrow(() => assertPrBodySections(COMPLIANT_BODY));
});

test('assertPrBodySections: rejects a missing section', () => {
  assert.throws(() => assertPrBodySections('## Summary\nx\n\n## Changes\n- a'), /Testing/);
});

test('assertPrBodySections: rejects out-of-order sections', () => {
  const reordered = '## Changes\n- a\n\n## Summary\nx\n\n## Testing\n- t';
  assert.throws(() => assertPrBodySections(reordered), /in order/);
});

test('assertPrBodySections: a section name in prose is not a heading', () => {
  // "## Testing" appears only inside Summary prose, not as its own heading line.
  const body = '## Summary\nSee `## Changes` and ## Testing notes inline.\n\n## Changes\n- a';
  assert.throws(() => assertPrBodySections(body), /Testing/);
});

test('openPr prompt instructs the standard PR body template', async () => {
  let capturedPrompt = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      capturedPrompt = JSON.stringify(options.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${submitCallId++}`,
            toolName: 'submit',
            input: JSON.stringify({ title: 't', body: COMPLIANT_BODY }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: { createPr: async (input) => basePr(input.head) },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.match(capturedPrompt, /## Summary/);
  assert.match(capturedPrompt, /## Changes/);
  assert.match(capturedPrompt, /## Testing/);
});

test('composePr throws a schema-validation error when the submitted composition is invalid (issue #101)', async () => {
  // submit called with a composition missing `body` → PrCompositionSchema.safeParse fails →
  // the forced-submit path (no agent loop, no retry) surfaces the typed failure as an error.
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: `submit-${submitCallId++}`,
          toolName: 'submit',
          input: JSON.stringify({ title: 't' }),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
  const { provider } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: { createPr: async (input) => basePr(input.head) },
  });
  await assert.rejects(o.openPr(baseGroup(), baseDelivery(), 'main'), /schema validation/i);
});

test('composePr throws a no-submission error when the model never submits a composition (issue #101)', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'no submission here' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
  const { provider } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: { createPr: async (input) => basePr(input.head) },
  });
  await assert.rejects(
    o.openPr(baseGroup(), baseDelivery(), 'main'),
    /did not submit a PR composition/i,
  );
});

test('openPr prompt anchors the title on the group goal, not the worker draft message', async () => {
  let capturedPrompt = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      capturedPrompt = JSON.stringify(options.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${submitCallId++}`,
            toolName: 'submit',
            input: JSON.stringify({ title: 't', body: COMPLIANT_BODY }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider } = recordingProvider(model);
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: { createPr: async (input) => basePr(input.head) },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');

  // Title must come from the group goal, with the worker draft demoted to body-only context.
  assert.match(capturedPrompt, /PR group goal/);
  assert.match(capturedPrompt, /Do NOT copy a single commit message/);
  assert.match(capturedPrompt, /context for the body only/);
});

test('openPr uses group.branch when set, otherwise aitm/<id>', async () => {
  const composition = { title: 't', body: COMPLIANT_BODY };
  const model = modelSubmitting(composition);
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
    maxSteps: null,
    github,
  });
  const customGroup = { ...baseGroup(), branch: 'feature/custom' };
  await o.openPr(customGroup, baseDelivery(), 'main');
  assert.equal(createCalls[0]?.head, 'feature/custom');
});

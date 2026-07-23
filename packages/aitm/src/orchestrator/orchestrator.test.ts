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
  buildFallbackComposition,
  COMPOSE_PR_MAX_RETRIES,
  compositionOutcome,
  DEFAULT_MAX_STEPS,
  describeSubmitPayload,
  type GhClient,
  ORCHESTRATOR_ROLE_PREFIX,
  Orchestrator,
  type OrchestratorBuildContext,
  PR_BODY_GUIDE,
  PR_BODY_SECTIONS,
  prBodyGuideFor,
  type RunCmd,
  recoverComposition,
  resolveMaxSteps,
  resolvePrBodySections,
  SUBMIT_PAYLOAD_PREVIEW_CHARS,
  submitToolInput,
  submittedComposition,
  truncateAtWord,
} from './orchestrator.ts';
import type { ModelProvider } from './subagent-tools.ts';

// A PR body that satisfies the section contract (assertPrBodySections), reused by openPr tests.
const COMPLIANT_BODY =
  '## Summary\nDid the thing.\n\n## Changes\n- a.ts: added\n\n## Testing\n- ran tests\n\n## Evidence\n- `bun test` exited 0';

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

// A model that submits each composition in `values` on successive generations (the last repeats),
// exposing a live call count — drives the composePr in-conversation retry loop across attempts.
function sequenceModel(values: readonly unknown[]): {
  model: MockLanguageModelV3;
  count: () => number;
} {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const value = values[Math.min(calls, values.length - 1)];
      calls += 1;
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${submitCallId++}`,
            toolName: 'submit',
            input: JSON.stringify(value ?? {}),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  return { model, count: () => calls };
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

test('PR_BODY_GUIDE defines the standard Summary/Changes/Testing/Evidence sections', () => {
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
  assert.match(capturedPrompt, /## Evidence/);
});

test('PR_BODY_GUIDE: the Evidence section forbids unearned claims', () => {
  assert.match(PR_BODY_GUIDE, /## Evidence/);
  assert.match(PR_BODY_GUIDE, /acceptance/i);
  assert.match(PR_BODY_GUIDE, /thrown away/i);
  assert.match(PR_BODY_GUIDE, /ONLY what the/);
  assert.match(PR_BODY_GUIDE, /Nothing was run to verify this/);
  assert.match(PR_BODY_GUIDE, /never evidence/);
});

test('openPr prompt carries the group acceptance check for the Evidence section', async () => {
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
  await o.openPr(
    { ...baseGroup(), acceptance: 'bun test src/auth passes' },
    baseDelivery(),
    'main',
  );
  assert.match(capturedPrompt, /Acceptance check the plan set for this group/);
  assert.match(capturedPrompt, /bun test src\/auth passes/);
});

test('openPr prompt omits the acceptance line for a group without a check (legacy state)', async () => {
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
  assert.doesNotMatch(capturedPrompt, /Acceptance check the plan set/);
});

test('buildFallbackComposition: Evidence claims nothing was run and flags the check undemonstrated', () => {
  const { body } = buildFallbackComposition(
    { ...baseGroup(), acceptance: 'POST /login sets a session cookie' },
    baseDelivery(),
    PR_BODY_SECTIONS,
  );
  const evidence = body.slice(body.indexOf('## Evidence'));
  assert.match(evidence, /No verification output was captured/);
  assert.match(evidence, /POST \/login sets a session cookie/);
  assert.match(evidence, /NOT demonstrated/);
  assert.doesNotMatch(evidence, /passed|green|verified successfully/i);
});

test('buildFallbackComposition: Evidence says so when the group has no acceptance check', () => {
  const { body } = buildFallbackComposition(baseGroup(), baseDelivery(), PR_BODY_SECTIONS);
  const evidence = body.slice(body.indexOf('## Evidence'));
  assert.match(evidence, /no recorded acceptance check/);
  assert.doesNotThrow(() => assertPrBodySections(body, PR_BODY_SECTIONS));
});

test('composePr falls back to a deterministic composition when every submission stays schema-invalid (#101)', async () => {
  // submit is called with a composition missing `body` on every attempt → PrCompositionSchema fails
  // each time → after the in-conversation retries exhaust, composePr yields a generated fallback
  // instead of throwing, so the group opens a PR rather than blocking at pr-open.
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
  const progress: string[] = [];
  const createCalls: CreatePrInput[] = [];
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {
      createPr: async (input) => {
        createCalls.push(input);
        return basePr(input.head);
      },
    },
    onProgress: (m) => progress.push(m),
  });
  const pr = await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.equal(pr.number, 42);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0]?.title, 'feat: Core');
  assert.doesNotThrow(() => assertPrBodySections(createCalls[0]?.body ?? ''));
  assert.ok(
    progress.some((m) => m.includes('PR composition fell back to generated title/body')),
    'the fallback is announced via the progress sink',
  );
  assert.ok(
    progress.some((m) => m.includes('feat: Core')),
    'the final generated title is logged',
  );
});

test('composePr falls back when the model never submits a composition (#101)', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'no submission here' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
  const { provider } = recordingProvider(model);
  const progress: string[] = [];
  const createCalls: CreatePrInput[] = [];
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {
      createPr: async (input) => {
        createCalls.push(input);
        return basePr(input.head);
      },
    },
    onProgress: (m) => progress.push(m),
  });
  const pr = await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.equal(pr.number, 42);
  assert.equal(createCalls[0]?.title, 'feat: Core');
  assert.doesNotThrow(() => assertPrBodySections(createCalls[0]?.body ?? ''));
  assert.ok(progress.some((m) => m.includes('PR composition fell back to generated title/body')));
});

test('composePr retries over an over-long title, then accepts the corrected resubmit', async () => {
  // Attempt 0 exceeds the 72-char cap (PrCompositionSchema) → one corrective retry → attempt 1 valid.
  const good = { title: 'feat: core — add a', body: COMPLIANT_BODY };
  const { model, count } = sequenceModel([{ title: 'x'.repeat(80), body: COMPLIANT_BODY }, good]);
  const { provider } = recordingProvider(model);
  const createCalls: CreatePrInput[] = [];
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {
      createPr: async (input) => {
        createCalls.push(input);
        return basePr(input.head);
      },
    },
  });
  const pr = await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.equal(pr.number, 42);
  assert.equal(count(), 2, 'exactly one corrective retry');
  assert.equal(createCalls[0]?.title, good.title, 'the PR opens with the corrected title');
});

test('composePr retries over a body missing a required section, then accepts the corrected resubmit', async () => {
  // Attempt 0 is schema-valid but its body lacks Changes/Testing (assertPrBodySections) → retry.
  const good = { title: 'feat: core', body: COMPLIANT_BODY };
  const { model, count } = sequenceModel([
    { title: 'feat: core', body: '## Summary\nonly this' },
    good,
  ]);
  const { provider } = recordingProvider(model);
  const createCalls: CreatePrInput[] = [];
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {
      createPr: async (input) => {
        createCalls.push(input);
        return basePr(input.head);
      },
    },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.equal(count(), 2, 'exactly one corrective retry');
  assert.equal(createCalls[0]?.body, good.body);
});

test('composePr feeds the schema failure back as a corrective user turn, keeping the original prompt', async () => {
  const prompts: string[] = [];
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const value =
        calls++ === 0
          ? { title: 'x'.repeat(80), body: COMPLIANT_BODY }
          : { title: 'feat: core', body: COMPLIANT_BODY };
      return {
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
  assert.equal(calls, 2);
  const retryPrompt = prompts[1] ?? '';
  assert.match(retryPrompt, /failed schema validation/i, 'the retry quotes the schema failure');
  assert.match(retryPrompt, /PR group goal/, 'the original composition prompt is retained');
});

test('composePr bounds correction to COMPOSE_PR_MAX_RETRIES generations, then falls back to a valid ≤72 title', async () => {
  // Every attempt exceeds the title cap — the loop must stop after 1 + COMPOSE_PR_MAX_RETRIES tries,
  // then open the PR with the deterministic fallback (title ≤ 72), never throwing.
  const { model, count } = sequenceModel([{ title: 'x'.repeat(80), body: COMPLIANT_BODY }]);
  const { provider } = recordingProvider(model);
  const createCalls: CreatePrInput[] = [];
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {
      createPr: async (input) => {
        createCalls.push(input);
        return basePr(input.head);
      },
    },
  });
  const pr = await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.equal(pr.number, 42);
  assert.equal(count(), COMPOSE_PR_MAX_RETRIES + 1);
  assert.equal(createCalls[0]?.title, 'feat: Core');
  assert.ok(
    (createCalls[0]?.title.length ?? 99) <= 72,
    'the fallback title respects the 72-char cap',
  );
  assert.doesNotThrow(() => assertPrBodySections(createCalls[0]?.body ?? ''));
});

test('composePr falls back when every retry omits a required section', async () => {
  const { model, count } = sequenceModel([{ title: 'feat: core', body: '## Summary\nonly this' }]);
  const { provider } = recordingProvider(model);
  const createCalls: CreatePrInput[] = [];
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {
      createPr: async (input) => {
        createCalls.push(input);
        return basePr(input.head);
      },
    },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.equal(count(), COMPOSE_PR_MAX_RETRIES + 1);
  assert.doesNotThrow(() => assertPrBodySections(createCalls[0]?.body ?? ''));
});

// --- submit-envelope recovery (a composed answer arriving as a JSON string) ---
//
// ai@6's parseToolCall records a schema-invalid `submit` call with `input` set to whatever JSON.parse
// of the raw arguments yielded — a STRING when the model double-encoded its payload. Zod then reports
// `<root>: Invalid input: expected object, received string` and a perfectly good composition was being
// discarded. The compat package's submittedOutput salvages the two simplest shapes; these cover the
// residual ones observed in production, which render with the identical error text.
//
// `modelSubmitting` / `sequenceModel` JSON.stringify their value, so passing a *string* reproduces the
// wire shape exactly: the tool arguments are a JSON string literal wrapping the real payload.

// A composition the composer would produce, plus its plain JSON encoding.
const RECOVERABLE = { title: 'feat: core — add a', body: COMPLIANT_BODY };
const RECOVERABLE_JSON = JSON.stringify(RECOVERABLE);

async function openPrWith(model: MockLanguageModelV3): Promise<{
  createCalls: CreatePrInput[];
  progress: string[];
}> {
  const { provider } = recordingProvider(model);
  const createCalls: CreatePrInput[] = [];
  const progress: string[] = [];
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: { flavor: 'claude', path: '/tmp/CLAUDE.md', contents: '' },
    rollingContext: '',
    maxSteps: null,
    github: {
      createPr: async (input) => {
        createCalls.push(input);
        return basePr(input.head);
      },
    },
    onProgress: (m) => progress.push(m),
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');
  return { createCalls, progress };
}

test('composePr recovers a composition double-wrapped as a JSON string, without spending a retry', async () => {
  // The reported failure: `<root>: Invalid input: expected object, received string`. One extra encoding
  // layer past what the compat salvage unwraps — the model's answer is intact, only its envelope is
  // wrong, so the PR must open with the COMPOSED prose on the first generation, not the fallback.
  const { model, count } = sequenceModel([JSON.stringify(RECOVERABLE_JSON)]);
  const { createCalls, progress } = await openPrWith(model);
  assert.equal(count(), 1, 'the recovered composition costs no corrective retry');
  assert.equal(createCalls[0]?.title, RECOVERABLE.title);
  assert.equal(createCalls[0]?.body, RECOVERABLE.body);
  assert.deepEqual(progress, [], 'no fallback is announced');
});

test('composePr recovers a ```-fenced composition whose fence is followed by prose', async () => {
  const fenced = `\`\`\`json\n${RECOVERABLE_JSON}\n\`\`\`\nHope that works!`;
  const { model, count } = sequenceModel([fenced]);
  const { createCalls, progress } = await openPrWith(model);
  assert.equal(count(), 1);
  assert.equal(createCalls[0]?.title, RECOVERABLE.title);
  assert.deepEqual(progress, []);
});

test('composePr recovers a composition embedded in a prose submit payload', async () => {
  const { model, count } = sequenceModel([`Here is the composition:\n${RECOVERABLE_JSON}`]);
  const { createCalls, progress } = await openPrWith(model);
  assert.equal(count(), 1);
  assert.equal(createCalls[0]?.body, RECOVERABLE.body);
  assert.deepEqual(progress, []);
});

test('composePr still falls back when a string payload parses but is schema-invalid', async () => {
  // The envelope unwraps cleanly, the composition inside does not validate (title > 72). Recovery must
  // not rescue it: the corrective retries run and the deterministic fallback opens the PR.
  const overLong = JSON.stringify({ title: 'x'.repeat(80), body: COMPLIANT_BODY });
  const { model, count } = sequenceModel([JSON.stringify(overLong)]);
  const { createCalls, progress } = await openPrWith(model);
  assert.equal(
    count(),
    COMPOSE_PR_MAX_RETRIES + 1,
    'a malformed submission still burns its retries',
  );
  assert.equal(createCalls[0]?.title, 'feat: Core');
  assert.ok(progress.some((m) => m.includes('PR composition fell back to generated title/body')));
});

test('composePr still falls back when the submit payload is prose, and the notice quotes it', async () => {
  const { model, count } = sequenceModel(['I could not compose this pull request.']);
  const { createCalls, progress } = await openPrWith(model);
  assert.equal(count(), COMPOSE_PR_MAX_RETRIES + 1);
  assert.equal(createCalls[0]?.title, 'feat: Core');
  const notice = progress.find((m) => m.includes('fell back')) ?? '';
  assert.match(notice, /expected object, received string/, 'the schema verdict is kept');
  assert.match(notice, /submitted string \(\d+ chars\)/, 'the payload kind and size are named');
  assert.match(notice, /I could not compose this pull request\./, 'the payload itself is quoted');
});

test('composePr leaves a well-typed object submission on exactly its old path', async () => {
  // The control: an ordinary submission never touches the recovery boundary — one generation, composed
  // title and body verbatim, no notice.
  const { model, count } = sequenceModel([RECOVERABLE]);
  const { createCalls, progress } = await openPrWith(model);
  assert.equal(count(), 1);
  assert.deepEqual(createCalls[0], {
    title: RECOVERABLE.title,
    body: RECOVERABLE.body,
    base: 'main',
    head: 'aitm/core',
  });
  assert.deepEqual(progress, []);
});

function stepsWith(input: unknown) {
  return { steps: [{ toolCalls: [{ toolName: 'submit', input }] }] };
}

test('submitToolInput: returns the raw submit input, undefined when the model never submitted', () => {
  assert.equal(submitToolInput(stepsWith('"{}"')), '"{}"');
  assert.deepEqual(submitToolInput(stepsWith({ title: 't' })), { title: 't' });
  assert.equal(submitToolInput({ steps: [{ toolCalls: [] }] }), undefined);
  assert.equal(
    submitToolInput({ steps: [{ toolCalls: [{ toolName: 'other', input: 'x' }] }] }),
    undefined,
  );
});

test('recoverComposition: peels nested JSON-string envelopes up to the bound', () => {
  assert.deepEqual(recoverComposition(RECOVERABLE_JSON), RECOVERABLE);
  assert.deepEqual(recoverComposition(JSON.stringify(RECOVERABLE_JSON)), RECOVERABLE);
  assert.deepEqual(
    recoverComposition(JSON.stringify(JSON.stringify(RECOVERABLE_JSON))),
    RECOVERABLE,
  );
  // A fourth layer is past MAX_JSON_PEELS — bounded, never an unbounded unwrap loop.
  assert.equal(
    recoverComposition(JSON.stringify(JSON.stringify(JSON.stringify(RECOVERABLE_JSON)))),
    undefined,
  );
});

test('recoverComposition: unwraps a ```-fenced payload with or without a trailing newline', () => {
  assert.deepEqual(recoverComposition(`\`\`\`json\n${RECOVERABLE_JSON}\n\`\`\``), RECOVERABLE);
  assert.deepEqual(recoverComposition(`\`\`\`json\n${RECOVERABLE_JSON}\`\`\``), RECOVERABLE);
  assert.deepEqual(recoverComposition(`\`\`\`\n${RECOVERABLE_JSON}\n\`\`\`\ndone!`), RECOVERABLE);
});

test('recoverComposition: extracts a JSON object embedded in narration', () => {
  assert.deepEqual(recoverComposition(`Here you go:\n${RECOVERABLE_JSON}\nThanks!`), RECOVERABLE);
});

test('recoverComposition: braces inside the body string do not truncate the object', () => {
  const braced = {
    title: 'feat: core',
    body: `${COMPLIANT_BODY}\n\nSee \`fn() { return "}"; }\`.`,
  };
  const recovered = recoverComposition(JSON.stringify(JSON.stringify(braced)));
  assert.deepEqual(recovered, braced);
});

test('recoverComposition: prose, non-strings, and schema-invalid payloads stay unrecovered', () => {
  assert.equal(recoverComposition('I could not compose this'), undefined);
  assert.equal(recoverComposition(''), undefined);
  assert.equal(recoverComposition(undefined), undefined);
  assert.equal(recoverComposition({ title: 't', body: 'b' }), undefined, 'objects are not re-read');
  assert.equal(
    recoverComposition(JSON.stringify(JSON.stringify({ title: 'x'.repeat(80), body: 'b' }))),
    undefined,
    'a parsing envelope around an invalid composition is still rejected',
  );
  assert.equal(
    recoverComposition(JSON.stringify(JSON.stringify({ title: 'only a title' }))),
    undefined,
    'a missing field is not filled in',
  );
});

test('submittedComposition: a valid object submission and a no-submission are passed through', () => {
  assert.deepEqual(submittedComposition(stepsWith(RECOVERABLE)), { ok: true, value: RECOVERABLE });
  assert.deepEqual(submittedComposition({ steps: [{ toolCalls: [] }] }), {
    ok: false,
    reason: 'no-submission',
  });
});

test('submittedComposition: a string envelope is recovered, a genuinely bad payload stays invalid', () => {
  assert.deepEqual(submittedComposition(stepsWith(JSON.stringify(RECOVERABLE_JSON))), {
    ok: true,
    value: RECOVERABLE,
  });
  const bad = submittedComposition(stepsWith('nothing json about this'));
  assert.equal(bad.ok, false);
  if (bad.ok) throw new Error('unreachable');
  assert.equal(bad.reason, 'invalid');
});

test('describeSubmitPayload: names the payload kind and size, truncating a long one', () => {
  assert.equal(describeSubmitPayload(undefined), '', 'no payload → no suffix');
  assert.match(
    describeSubmitPayload('prose here'),
    /^; submitted string \(10 chars\): prose here$/,
  );
  // Newlines are collapsed so the notice stays one line.
  assert.match(describeSubmitPayload('a\nb'), /: a b$/);
  const long = describeSubmitPayload('x'.repeat(SUBMIT_PAYLOAD_PREVIEW_CHARS + 50));
  assert.ok(long.endsWith('…'), 'an over-long payload is truncated');
  assert.ok(!long.includes('x'.repeat(SUBMIT_PAYLOAD_PREVIEW_CHARS + 1)));
  assert.match(
    describeSubmitPayload({ title: 't' }),
    /^; submitted object \(\d+ chars\): \{"title/,
  );
});

test('compositionOutcome: the schema-failure reason quotes the offending payload when given', () => {
  const parsed = z.object({ title: z.string() }).safeParse('a string, not an object');
  if (parsed.success) throw new Error('expected a validation failure');
  const withPayload = compositionOutcome(
    { ok: false, reason: 'invalid', issues: parsed.error.issues },
    PR_BODY_SECTIONS,
    'a string, not an object',
  );
  assert.equal(withPayload.ok, false);
  if (withPayload.ok) throw new Error('unreachable');
  assert.match(withPayload.reason, /failed schema validation/);
  assert.match(withPayload.reason, /submitted string \(23 chars\): a string, not an object/);
  // The model-facing correction already restates the issues — it must not grow the payload echo.
  assert.doesNotMatch(withPayload.correction, /submitted string/);
});

test('compositionOutcome: a no-submission reason is never decorated with a payload', () => {
  const outcome = compositionOutcome({ ok: false, reason: 'no-submission' }, PR_BODY_SECTIONS, 'x');
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.doesNotMatch(outcome.reason, /submitted string/);
});

test('compositionOutcome: valid submission with a compliant body → ok', () => {
  const outcome = compositionOutcome(
    { ok: true, value: { title: 'feat: core', body: COMPLIANT_BODY } },
    PR_BODY_SECTIONS,
  );
  assert.deepEqual(outcome, { ok: true, value: { title: 'feat: core', body: COMPLIANT_BODY } });
});

test('compositionOutcome: no-submission → reason + a submit corrective', () => {
  const outcome = compositionOutcome({ ok: false, reason: 'no-submission' }, PR_BODY_SECTIONS);
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.match(outcome.reason, /did not submit a PR composition/);
  assert.match(outcome.correction, /submit/i);
});

test('compositionOutcome: schema-invalid → reason quotes issues, corrective asks for a resubmit', () => {
  const issues = z.string().max(72).safeParse('x'.repeat(80));
  if (issues.success) throw new Error('expected a validation failure');
  const outcome = compositionOutcome(
    { ok: false, reason: 'invalid', issues: issues.error.issues },
    PR_BODY_SECTIONS,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.match(outcome.reason, /failed schema validation/);
  assert.match(outcome.correction, /failed schema validation/);
});

test('compositionOutcome: valid submission with a non-compliant body → section corrective', () => {
  const outcome = compositionOutcome(
    { ok: true, value: { title: 'feat: core', body: '## Summary\nonly this' } },
    PR_BODY_SECTIONS,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error('unreachable');
  assert.match(outcome.reason, /heading lines/);
  assert.match(outcome.correction, /submit/i);
});

test('truncateAtWord: input at or under max is returned unchanged', () => {
  assert.equal(truncateAtWord('feat: core', 72), 'feat: core');
  assert.equal(truncateAtWord('x'.repeat(72), 72), 'x'.repeat(72));
});

test('truncateAtWord: retreats to the last word boundary, never mid-word, result ≤ max', () => {
  const out = truncateAtWord('feat: add the observability and caching subsystems today', 30);
  assert.ok(out.length <= 30, 'result respects max');
  assert.ok(!out.endsWith(' '), 'no trailing space');
  assert.equal(out, 'feat: add the observability');
});

test('truncateAtWord: a single word longer than max is hard-sliced to max', () => {
  const out = truncateAtWord('x'.repeat(100), 72);
  assert.equal(out.length, 72);
  assert.equal(out, 'x'.repeat(72));
});

test('buildFallbackComposition: title is feat:<group.title>, capped ≤72 on a word boundary', () => {
  const { title } = buildFallbackComposition(baseGroup(), baseDelivery(), PR_BODY_SECTIONS);
  assert.equal(title, 'feat: Core');
  const longTitleGroup = { ...baseGroup(), title: 'add '.repeat(40).trim() };
  const long = buildFallbackComposition(longTitleGroup, baseDelivery(), PR_BODY_SECTIONS);
  assert.ok(long.title.length <= 72, 'a long group title is capped to 72');
  assert.ok(long.title.startsWith('feat: add'), 'the title keeps the feat: prefix and subject');
});

test('buildFallbackComposition: empty group.title falls back to the group id', () => {
  const { title } = buildFallbackComposition(
    { ...baseGroup(), title: '   ' },
    baseDelivery(),
    PR_BODY_SECTIONS,
  );
  assert.equal(title, 'feat: core');
});

test('buildFallbackComposition: body passes assertPrBodySections for the default section set', () => {
  const { body } = buildFallbackComposition(baseGroup(), baseDelivery(), PR_BODY_SECTIONS);
  assert.doesNotThrow(() => assertPrBodySections(body, PR_BODY_SECTIONS));
  // The Changes section groups paths by directory and lists the change-kind — it never echoes the
  // raw (often noisy) editor summaries.
  assert.match(body, /- \*\*src\/\*\* — create a\.ts; modify b\.ts/);
});

test('buildFallbackComposition: body passes assertPrBodySections for a custom section set', () => {
  const custom = ['## What', '## Why', '## Verification'];
  const { body } = buildFallbackComposition(baseGroup(), baseDelivery(), custom);
  assert.doesNotThrow(() => assertPrBodySections(body, custom));
});

test('buildFallbackComposition: an empty change set still yields a valid, non-empty Changes section', () => {
  const delivery = { ...baseDelivery(), changes: [] };
  const { body } = buildFallbackComposition(baseGroup(), delivery, PR_BODY_SECTIONS);
  assert.doesNotThrow(() => assertPrBodySections(body, PR_BODY_SECTIONS));
});

test('buildFallbackComposition: a noisy change summary is dropped, never echoed or able to inject a heading', () => {
  // The fallback builds the Changes list from path + kind only; the raw summary (which can carry
  // newlines, agent self-talk, or a smuggled `##` heading) is never placed in the body.
  const delivery = {
    ...baseDelivery(),
    changes: [{ path: 'src/a.ts', kind: 'modify' as const, summary: 'line1\n## Testing\nline2' }],
  };
  const { body } = buildFallbackComposition(baseGroup(), delivery, PR_BODY_SECTIONS);
  assert.doesNotThrow(() => assertPrBodySections(body, PR_BODY_SECTIONS));
  const testingHeadings = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l === '## Testing');
  assert.equal(testingHeadings.length, 1, 'no smuggled heading from the summary');
  assert.ok(!body.includes('line1'), 'the raw summary text is dropped, not echoed');
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

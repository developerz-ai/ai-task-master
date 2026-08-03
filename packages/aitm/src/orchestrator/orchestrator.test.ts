import { agentConfig } from '../testing/domain-fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StepTimeoutError } from '@developerz.ai/ai-claude-compat';
import { MockLanguageModelV3 } from 'ai/test';
import type { PrGroup } from '../domain/pr-group.ts';
import type { Role } from '../domain/role.ts';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';
import type { CreatePrInput } from '../github/github-client.ts';
import type { PullRequest } from '../github/schema.ts';
import { MANIFEST_FIELD_MAX } from '../subagents/worker.ts';
import { emptyUsage } from '../testing/model-fixtures.ts';
import { stallingModel } from '../testing/stalling-model.ts';
import { taskCommitTrailer } from '../workspace/task-commit-marker.ts';
import {
  COMPOSER_ROLE_PREFIX,
  DEFAULT_CMD_TIMEOUT_MS,
  execaOptions,
  type GhClient,
  type ModelProvider,
  Orchestrator,
  type RunCmd,
} from './orchestrator.ts';
import { assertPrBodySections, COMPOSE_PR_MAX_RETRIES } from './pr-body.ts';

// A PR body that satisfies the section contract (assertPrBodySections), reused by openPr tests.
const COMPLIANT_BODY =
  '## Summary\nDid the thing.\n\n## Changes\n- a.ts: added\n\n## Testing\n- ran tests\n\n## Evidence\n- `bun test` exited 0';

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
    stage: 'pending',
    reviewGraceApplied: false,
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

test('Orchestrator is constructible', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: {} as never,
  });
  assert.ok(o instanceof Orchestrator);
});

test('buildSystemPrompt = agentConfig.contents + COMPOSER_ROLE_PREFIX + rollingContext', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '# repo style' }),
    rollingContext: 'prior PRs: 1, 2',
    github: {} as never,
  });
  const sys = o.buildSystemPrompt();
  assert.ok(sys.includes('# repo style'), 'style payload must be present');
  assert.ok(sys.includes(COMPOSER_ROLE_PREFIX), 'role prefix must be present');
  assert.ok(sys.includes('prior PRs: 1, 2'), 'rolling context must be present');
  // Ordering: style comes before role prefix, role prefix before rolling context.
  assert.ok(sys.indexOf('# repo style') < sys.indexOf(COMPOSER_ROLE_PREFIX));
  assert.ok(sys.indexOf(COMPOSER_ROLE_PREFIX) < sys.indexOf('prior PRs: 1, 2'));
});

test('buildSystemPrompt: styleDigest replaces agentConfig.contents as the style prefix', () => {
  const o = new Orchestrator({
    credentials: {} as never,
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '# raw style' }),
    styleDigest: '# distilled digest',
    rollingContext: 'prior PRs: 1',
    github: {} as never,
  });
  const sys = o.buildSystemPrompt();
  assert.ok(sys.includes('# distilled digest'), 'digest must be used as the style prefix');
  assert.ok(!sys.includes('# raw style'), 'raw contents must be suppressed when digest present');
  assert.ok(sys.includes(COMPOSER_ROLE_PREFIX), 'role prefix must be present');
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '# repo style' }),
    rollingContext: 'prior PRs: 1',
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
  assert.match(JSON.stringify(system), new RegExp(COMPOSER_ROLE_PREFIX.split('\n')[1] ?? ''));
  // The role prefix (part of buildSystemPrompt) must not be re-concatenated into the user turn.
  assert.doesNotMatch(rest, /## Role: PR composer/);
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '# repo style' }),
    rollingContext: 'prior PRs: 1',
    github: { createPr: async (input) => basePr(input.head) },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');

  const messages = captured as ReadonlyArray<{ role: string; content: unknown }>;
  const system = messages.find((m) => m.role === 'system');
  const rest = JSON.stringify(messages.filter((m) => m.role !== 'system'));
  assert.ok(system, 'a system message must be present');
  assert.match(JSON.stringify(system), /# repo style/);
  assert.doesNotMatch(rest, /## Role: PR composer/);
});

// A field long enough that its tail sentinel sits well past the cap; a single unbroken token so the
// word-boundary truncation hard-slices at exactly MANIFEST_FIELD_MAX rather than retreating earlier.
function oversized(head: string, tail: string): string {
  return `${head}${'x'.repeat(MANIFEST_FIELD_MAX + 100)}${tail}`;
}

test('finalizeCommit: interpolated title/draft/summary are capped at MANIFEST_FIELD_MAX', async () => {
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: {} as never,
    runCmd: async (file, args) =>
      args[0] === 'rev-parse'
        ? { stdout: 'deadbeef\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
  });
  const group = { ...baseGroup(), title: oversized('TITLEHEAD', 'TITLETAIL') };
  const delivery: WorkerDelivery = {
    ...baseDelivery(),
    draftCommitMessage: oversized('DRAFTHEAD', 'DRAFTTAIL'),
    changes: [{ path: 'src/a.ts', kind: 'create', summary: oversized('SUMMHEAD', 'SUMMTAIL') }],
  };
  await o.finalizeCommit(group, delivery, '/tmp/wt');

  const user = JSON.stringify(
    (captured as ReadonlyArray<{ role: string }>).filter((m) => m.role !== 'system'),
  );
  for (const head of ['TITLEHEAD', 'DRAFTHEAD', 'SUMMHEAD']) {
    assert.match(user, new RegExp(head), `${head} survives the cap`);
  }
  for (const tail of ['TITLETAIL', 'DRAFTTAIL', 'SUMMTAIL']) {
    assert.doesNotMatch(user, new RegExp(tail), `${tail} is truncated past MANIFEST_FIELD_MAX`);
  }
});

test('openPr: interpolated title/acceptance/draft/summary are capped at MANIFEST_FIELD_MAX', async () => {
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: { createPr: async (input) => basePr(input.head) },
  });
  const group = {
    ...baseGroup(),
    title: oversized('TITLEHEAD', 'TITLETAIL'),
    acceptance: oversized('ACCHEAD', 'ACCTAIL'),
  };
  const delivery: WorkerDelivery = {
    ...baseDelivery(),
    draftCommitMessage: oversized('DRAFTHEAD', 'DRAFTTAIL'),
    changes: [{ path: 'src/a.ts', kind: 'create', summary: oversized('SUMMHEAD', 'SUMMTAIL') }],
  };
  await o.openPr(group, delivery, 'main');

  const user = JSON.stringify(
    (captured as ReadonlyArray<{ role: string }>).filter((m) => m.role !== 'system'),
  );
  for (const head of ['TITLEHEAD', 'ACCHEAD', 'DRAFTHEAD', 'SUMMHEAD']) {
    assert.match(user, new RegExp(head), `${head} survives the cap`);
  }
  for (const tail of ['TITLETAIL', 'ACCTAIL', 'DRAFTTAIL', 'SUMMTAIL']) {
    assert.doesNotMatch(user, new RegExp(tail), `${tail} is truncated past MANIFEST_FIELD_MAX`);
  }
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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

test('finalizeCommit: an empty refine response amends with the Worker draft, not an empty message', async () => {
  // Without the total fallback this would run `git commit --amend -m ''` and fail the whole group.
  const { provider } = recordingProvider(modelEmitting(''));
  const calls: Array<readonly string[]> = [];
  const runCmd: RunCmd = async (_file, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { stdout: 'shaXYZ\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: {} as never,
    runCmd,
  });
  await o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt');
  assert.deepEqual(calls[0], ['commit', '--amend', '-m', 'feat: add a']);
});

test('finalizeCommit: a code-fenced refine response amends with the fence stripped', async () => {
  const { provider } = recordingProvider(modelEmitting('```\nfeat(core): add module a\n```'));
  const calls: Array<readonly string[]> = [];
  const runCmd: RunCmd = async (_file, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { stdout: 'shaXYZ\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: {} as never,
    runCmd,
  });
  await o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt');
  assert.deepEqual(calls[0], ['commit', '--amend', '-m', 'feat(core): add module a']);
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: 'prior: nothing yet',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: 'prior: nothing yet',
    github: { createPr: async (input) => basePr(input.head) },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.deepEqual(seenToolChoice, { type: 'auto' });
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: { createPr: async (input) => basePr(input.head) },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.match(capturedPrompt, /## Summary/);
  assert.match(capturedPrompt, /## Changes/);
  assert.match(capturedPrompt, /## Testing/);
  assert.match(capturedPrompt, /## Evidence/);
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: { createPr: async (input) => basePr(input.head) },
  });
  await o.openPr(baseGroup(), baseDelivery(), 'main');
  assert.doesNotMatch(capturedPrompt, /Acceptance check the plan set/);
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
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
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github,
  });
  const customGroup = { ...baseGroup(), branch: 'feature/custom' };
  await o.openPr(customGroup, baseDelivery(), 'main');
  assert.equal(createCalls[0]?.head, 'feature/custom');
});

test('execaOptions: no options → the default deadline, nothing else', () => {
  assert.deepEqual(execaOptions(), { timeout: DEFAULT_CMD_TIMEOUT_MS });
});

test('execaOptions: cwd + explicit timeout + signal → execa cwd/timeout/cancelSignal', () => {
  const controller = new AbortController();
  assert.deepEqual(execaOptions({ cwd: '/tmp/wt', timeout: 25, signal: controller.signal }), {
    cwd: '/tmp/wt',
    timeout: 25,
    cancelSignal: controller.signal,
  });
});

test('finalizeCommit: the run signal reaches every git child', async () => {
  const { provider } = recordingProvider(modelEmitting('feat(core): add a'));
  const seen: Array<AbortSignal | undefined> = [];
  const runCmd: RunCmd = async (_file, args, options) => {
    seen.push(options?.signal);
    if (args[0] === 'rev-parse') return { stdout: 'shaXYZ\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const controller = new AbortController();

  const o = new Orchestrator({
    credentials: provider,
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: {} as never,
    runCmd,
    signal: controller.signal,
  });

  assert.equal(await o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt'), 'shaXYZ');
  assert.deepEqual(seen, [controller.signal, controller.signal]);
});

test('finalizeCommit: the run signal also cancels the refine generateText call', async () => {
  const { provider } = recordingProvider(stallingModel());
  const controller = new AbortController();
  const o = new Orchestrator({
    credentials: provider,
    agentConfig: agentConfig({ path: '/tmp/CLAUDE.md', contents: '' }),
    rollingContext: '',
    github: {} as never,
    runCmd: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    signal: controller.signal,
  });

  const pending = o.finalizeCommit(baseGroup(), baseDelivery(), '/tmp/wt');
  // Abort once the request is in flight: stallingModel settles off the abort EVENT, so a signal that
  // fired before generateText armed its listener would leave the call hanging forever.
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { Role } from '../credentials/credentials.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { Plan } from '../plan/schema.ts';
import type { PrGroup } from '../state/schema.ts';
import type {
  GithubToolInput,
  GithubToolOutput,
  ReviewerTools,
  ThreadResolutionOutput,
} from '../subagents/reviewer.ts';
import type {
  BashInput,
  BashOutput,
  FileManifest,
  ReadFileInput,
  ReadFileOutput,
  WorkerTools,
  WriteFileInput,
  WriteFileOutput,
} from '../subagents/worker.ts';
import {
  type ModelProvider,
  makePlannerTool,
  makeReviewerTool,
  makeWorkerTool,
  type PlannerToolDeps,
  type ReviewerToolDeps,
  type WorkerToolDeps,
} from './subagent-tools.ts';

function emptyUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
    totalTokens: 2,
  };
}

function modelEmitting(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
}

// Subagents deliver structured output via the submit tool-call now, so the mock "submits" the
// value (input is a JSON string) instead of emitting it as text.
let submitCallId = 0;
function submitContent(value: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: `submit-${submitCallId++}`,
        toolName: 'submit',
        input: JSON.stringify(value),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: emptyUsage(),
    warnings: [],
  };
}

function modelSubmitting(value: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doGenerate: async () => submitContent(value) });
}

function recordingProvider(model: MockLanguageModelV3): {
  provider: ModelProvider;
  calls: Role[];
} {
  const calls: Role[] = [];
  return {
    provider: {
      modelFor(role) {
        calls.push(role);
        return model;
      },
    },
    calls,
  };
}

function makeWorkerTools(): { tools: WorkerTools; bashes: BashInput[] } {
  const bashes: BashInput[] = [];
  const tools: WorkerTools = {
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
      execute: async (input) => {
        // runEditor confirms each edit landed via `git status --porcelain`; report the path dirty so
        // the editor fanout records the change, and keep it out of the commit-phase `bashes` sequence.
        if (input.command.includes('status --porcelain')) {
          const path = /-- '(.*)'\s*$/.exec(input.command)?.[1] ?? '';
          return { stdout: ` M ${path}\n`, stderr: '', exitCode: 0 };
        }
        bashes.push(input);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
  };
  return { tools, bashes };
}

function makeReviewerTools(): { tools: ReviewerTools; bashes: BashInput[] } {
  const bashes: BashInput[] = [];
  const tools: ReviewerTools = {
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
      execute: async (input) => {
        bashes.push(input);
        return {
          stdout: input.command.includes('rev-parse HEAD') ? 'sha123\n' : '',
          stderr: '',
          exitCode: 0,
        };
      },
    }),
    github: tool<GithubToolInput, GithubToolOutput>({
      description: 'github',
      inputSchema: z.discriminatedUnion('action', [
        z.object({
          action: z.literal('replyToThread'),
          threadId: z.string(),
          body: z.string(),
        }),
        z.object({ action: z.literal('resolveThread'), threadId: z.string() }),
      ]),
      execute: async () => ({ ok: true }),
    }),
  };
  return { tools, bashes };
}

function basePlan(): Plan {
  return {
    goal: 'do the thing',
    groups: [
      { id: 'g1', title: 'First', tasks: [{ description: 't1' }], dependsOn: [] },
      { id: 'g2', title: 'Second', tasks: [{ description: 't2' }], dependsOn: ['g1'] },
    ],
  };
}

function baseGroup(): PrGroup {
  return {
    id: 'core',
    title: 'Core',
    tasks: [{ id: 'task-a', text: 'task A', complexity: 'normal', done: false }],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
  };
}

function baseThread(id: string, body: string): ReviewThread {
  return {
    id,
    isResolved: false,
    path: 'src/x.ts',
    comments: [{ id: `${id}-c1`, body, author: 'rev' }],
  };
}

test('makePlannerTool returns a Tool with description, inputSchema, execute, toModelOutput', () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const deps: PlannerToolDeps = {
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    checkoutPath: '/tmp/wt',
    plannerTools: {},
  };
  const t = makePlannerTool(deps);
  assert.equal(typeof t.description, 'string');
  assert.ok((t.description ?? '').length > 0);
  assert.ok(t.inputSchema);
  assert.equal(typeof t.execute, 'function');
  assert.equal(typeof t.toModelOutput, 'function');
});

test('makeWorkerTool returns a Tool with description, inputSchema, execute, toModelOutput', () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const { tools } = makeWorkerTools();
  const deps: WorkerToolDeps = {
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    workerTools: tools,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
  };
  const t = makeWorkerTool(deps);
  assert.equal(typeof t.description, 'string');
  assert.ok((t.description ?? '').length > 0);
  assert.ok(t.inputSchema);
  assert.equal(typeof t.execute, 'function');
  assert.equal(typeof t.toModelOutput, 'function');
});

test('makeReviewerTool returns a Tool with description, inputSchema, execute, toModelOutput', () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const { tools } = makeReviewerTools();
  const deps: ReviewerToolDeps = {
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    reviewerTools: tools,
    checkoutPath: '/tmp/wt',
    pr: 42,
    threads: [],
  };
  const t = makeReviewerTool(deps);
  assert.equal(typeof t.description, 'string');
  assert.ok((t.description ?? '').length > 0);
  assert.ok(t.inputSchema);
  assert.equal(typeof t.execute, 'function');
  assert.equal(typeof t.toModelOutput, 'function');
});

test('planner tool: execute resolves model via credentials.modelFor("planner") and runs runPlanner', async () => {
  const plan = basePlan();
  const model = modelSubmitting(plan);
  const { provider, calls } = recordingProvider(model);
  const t = makePlannerTool({
    credentials: provider,
    styleContents: '# style\n',
    rollingContext: '',
    checkoutPath: '/tmp/wt',
    plannerTools: {},
  });
  const exec = t.execute;
  assert.equal(typeof exec, 'function');
  if (typeof exec !== 'function') return;
  const out = await exec({ goal: 'do thing', maxPrs: 5 }, { toolCallId: 'tc1', messages: [] });
  assert.deepEqual(calls, ['planner']);
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') {
    assert.equal(out.plan.groups.length, 2);
    assert.equal(out.plan.groups[0]?.id, 'g1');
  }
});

test('planner tool: toModelOutput collapses ok result to "planner [ok]: …"', async () => {
  const plan = basePlan();
  const { provider } = recordingProvider(modelSubmitting(plan));
  const t = makePlannerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    checkoutPath: '/tmp/wt',
    plannerTools: {},
  });
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('no execute');
  const out = await exec({ goal: 'g', maxPrs: 3 }, { toolCallId: 'tc', messages: [] });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');
  const summary = await toModelOutput({
    toolCallId: 'tc',
    input: { goal: 'g', maxPrs: 3 },
    output: out,
  });
  assert.equal(summary.type, 'text');
  if (summary.type === 'text') {
    assert.match(summary.value, /^planner \[ok\]: 2 group\(s\) — g1, g2$/);
  }
});

test('planner tool: toModelOutput collapses blocked + error results', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const t = makePlannerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    checkoutPath: '/tmp/wt',
    plannerTools: {},
  });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');

  const blocked = await toModelOutput({
    toolCallId: 'tc',
    input: { goal: 'g', maxPrs: 3 },
    output: { kind: 'blocked', reason: 'empty' },
  });
  assert.equal(blocked.type, 'text');
  if (blocked.type === 'text') assert.match(blocked.value, /^planner \[blocked\]: empty$/);

  const err = await toModelOutput({
    toolCallId: 'tc',
    input: { goal: 'g', maxPrs: 3 },
    output: { kind: 'error', error: 'boom' },
  });
  assert.equal(err.type, 'text');
  if (err.type === 'text') assert.match(err.value, /^planner \[error\]: boom$/);
});

test('worker tool: execute resolves model via credentials.modelFor("worker") and runs runWorker', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/x.ts', kind: 'create', purpose: 'create x' }],
    draftCommitMessage: 'feat: x',
  };
  // First call submits the manifest (tool-call); the second is the editor text summary.
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      if (i++ === 0) return submitContent(manifest);
      return {
        content: [{ type: 'text', text: 'created x' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider, calls } = recordingProvider(model);
  const { tools, bashes } = makeWorkerTools();
  const t = makeWorkerTool({
    credentials: provider,
    styleContents: '# style\n',
    rollingContext: 'prior: nothing',
    workerTools: tools,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
  });
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('no execute');
  const out = await exec({}, { toolCallId: 'tc', messages: [] });
  assert.deepEqual(calls, ['worker']);
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') {
    assert.equal(out.delivery.branch, 'aitm/core');
    assert.equal(out.delivery.draftCommitMessage, 'feat: x');
    assert.equal(out.delivery.changes.length, 1);
  }
  // Worker commits on branch via bash — verifies tools were threaded through.
  // checkout -B, add -A, reset .ai-task-master, commit.
  assert.equal(bashes.length, 4);
  assert.match(bashes[0]?.command ?? '', /checkout -B 'aitm\/core'/);
});

test('worker tool: threads formatCommand, providerOptions, and onUsage into the Worker (parity with the direct spawn path)', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/x.ts', kind: 'create', purpose: 'create x' }],
    draftCommitMessage: 'feat: x',
  };
  // Capture providerOptions on every model call (manifest agent + editor generateText) and count
  // onUsage fires; both must be configured exactly as the direct run-loop spawn path configures them.
  const seenProviderOptions: unknown[] = [];
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      seenProviderOptions.push(opts.providerOptions);
      if (i++ === 0) return submitContent(manifest);
      return {
        content: [{ type: 'text', text: 'created x' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider } = recordingProvider(model);
  const { tools, bashes } = makeWorkerTools();
  const providerOptions = {
    openrouter: { tools: [{ type: 'openrouter:web_search', parameters: {} }] },
  };
  let usageCalls = 0;
  const t = makeWorkerTool({
    credentials: provider,
    styleContents: '# style\n',
    rollingContext: '',
    workerTools: tools,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
    formatCommand: 'bun run lint:fix',
    providerOptions,
    onUsage: () => {
      usageCalls++;
    },
  });
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('no execute');
  const out = await exec({}, { toolCallId: 'tc', messages: [] });
  assert.equal(out.kind, 'ok');

  // formatCommand: format runs in the checkout before staging — checkout, <format>, add, reset, commit.
  const cmds = bashes.map((b) => b.command);
  assert.equal(cmds.length, 5);
  assert.match(cmds[1] ?? '', /cd '\/tmp\/wt' && bun run lint:fix/);

  // providerOptions: forwarded to BOTH the manifest agent and the editor generateText call.
  assert.ok(seenProviderOptions.length >= 2, 'manifest + editor both generate');
  for (const po of seenProviderOptions) assert.deepEqual(po, providerOptions);

  // onUsage: fired at least once (per-generate usage sink threaded through).
  assert.ok(usageCalls >= 1, 'onUsage sink received at least one usage report');
});

test('worker tool: forwards timeout so a stalled Worker step surfaces a deadline error (parity with direct path)', async () => {
  const stalling = new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
  const { provider } = recordingProvider(stalling);
  const { tools } = makeWorkerTools();
  const t = makeWorkerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    workerTools: tools,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
    timeout: { stepMs: 40 },
  });
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('no execute');
  const out = await exec({}, { toolCallId: 'tc', messages: [] });
  assert.equal(out.kind, 'error');
  if (out.kind === 'error') assert.match(out.error, /exceeded the configured deadline/);
});

test('worker tool: omits the format step when formatCommand is unset (no config leaks in)', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/x.ts', kind: 'create', purpose: 'create x' }],
    draftCommitMessage: 'feat: x',
  };
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      if (i++ === 0) return submitContent(manifest);
      return {
        content: [{ type: 'text', text: 'created x' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider } = recordingProvider(model);
  const { tools, bashes } = makeWorkerTools();
  const t = makeWorkerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    workerTools: tools,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
  });
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('no execute');
  const out = await exec({}, { toolCallId: 'tc', messages: [] });
  assert.equal(out.kind, 'ok');
  // No format step: exactly checkout, add, reset .ai-task-master, commit.
  assert.equal(bashes.length, 4);
  assert.equal(
    bashes.some((b) => b.command.includes('lint:fix')),
    false,
  );
});

test('worker tool: toModelOutput collapses ok result to "worker [ok]: …"', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const { tools } = makeWorkerTools();
  const t = makeWorkerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    workerTools: tools,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
  });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');
  const summary = await toModelOutput({
    toolCallId: 'tc',
    input: {},
    output: {
      kind: 'ok',
      delivery: {
        branch: 'aitm/core',
        draftCommitMessage: 'feat: add a',
        changes: [
          { path: 'src/a.ts', kind: 'create', summary: 'created a' },
          { path: 'src/b.ts', kind: 'modify', summary: 'fixed b' },
        ],
        progressEntries: [],
      },
    },
  });
  assert.equal(summary.type, 'text');
  if (summary.type === 'text') {
    assert.match(summary.value, /^worker \[ok\]: aitm\/core — feat: add a \(2 file\(s\)\)$/);
  }
});

test('worker tool: toModelOutput collapses blocked + error results', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const { tools } = makeWorkerTools();
  const t = makeWorkerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    workerTools: tools,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
  });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');

  const blocked = await toModelOutput({
    toolCallId: 'tc',
    input: {},
    output: { kind: 'blocked', reason: 'empty manifest' },
  });
  assert.equal(blocked.type, 'text');
  if (blocked.type === 'text') assert.match(blocked.value, /^worker \[blocked\]: empty manifest$/);

  const err = await toModelOutput({
    toolCallId: 'tc',
    input: {},
    output: { kind: 'error', error: 'bash failed' },
  });
  assert.equal(err.type, 'text');
  if (err.type === 'text') assert.match(err.value, /^worker \[error\]: bash failed$/);
});

test('reviewer tool: execute resolves model via credentials.modelFor("reviewer") and runs runReviewer', async () => {
  const outputs: ThreadResolutionOutput[] = [{ kind: 'replied' }];
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => submitContent(outputs[i++] ?? { kind: 'replied' }),
  });
  const { provider, calls } = recordingProvider(model);
  const { tools } = makeReviewerTools();
  const t = makeReviewerTool({
    credentials: provider,
    styleContents: '# style\n',
    rollingContext: '',
    reviewerTools: tools,
    checkoutPath: '/tmp/wt',
    pr: 42,
    threads: [baseThread('T1', 'why?')],
  });
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('no execute');
  const out = await exec({}, { toolCallId: 'tc', messages: [] });
  assert.deepEqual(calls, ['reviewer']);
  assert.equal(out.kind, 'ok');
  if (out.kind === 'ok') {
    assert.equal(out.resolutions.length, 1);
    assert.equal(out.resolutions[0]?.kind, 'replied');
  }
});

test('reviewer tool: toModelOutput collapses ok result to "reviewer [ok]: …"', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const { tools } = makeReviewerTools();
  const t = makeReviewerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    reviewerTools: tools,
    checkoutPath: '/tmp/wt',
    pr: 1,
    threads: [],
  });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');
  const summary = await toModelOutput({
    toolCallId: 'tc',
    input: {},
    output: {
      kind: 'ok',
      resolutions: [
        { threadId: 'T1', kind: 'fixed', commitSha: 'abc' },
        { threadId: 'T2', kind: 'replied' },
        { threadId: 'T3', kind: 'wontfix', reason: 'oos' },
      ],
    },
  });
  assert.equal(summary.type, 'text');
  if (summary.type === 'text') {
    assert.match(summary.value, /^reviewer \[ok\]: 3 resolution\(s\) — /);
    assert.match(summary.value, /fixed=1/);
    assert.match(summary.value, /replied=1/);
    assert.match(summary.value, /wontfix=1/);
  }
});

test('planner tool: toModelOutput truncates long IDs to a preview + "+N more"', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const t = makePlannerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    checkoutPath: '/tmp/wt',
    plannerTools: {},
  });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');
  const groups = Array.from({ length: 12 }, (_, i) => ({
    id: `g${i + 1}`,
    title: 't',
    tasks: [{ description: 'x' }],
    dependsOn: [],
  }));
  const out = await toModelOutput({
    toolCallId: 'tc',
    input: { goal: 'g', maxPrs: 12 },
    output: { kind: 'ok', plan: { goal: 'g', groups } },
  });
  assert.equal(out.type, 'text');
  if (out.type === 'text') {
    assert.match(
      out.value,
      /^planner \[ok\]: 12 group\(s\) — g1, g2, g3, g4, g5, g6, g7, g8, \+4 more$/,
    );
  }
});

test('planner tool: toModelOutput collapses multiline / long error payloads to one bounded line', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const t = makePlannerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    checkoutPath: '/tmp/wt',
    plannerTools: {},
  });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');
  const longError = `line1\nline2\n${'x'.repeat(500)}`;
  const out = await toModelOutput({
    toolCallId: 'tc',
    input: { goal: 'g', maxPrs: 3 },
    output: { kind: 'error', error: longError },
  });
  assert.equal(out.type, 'text');
  if (out.type === 'text') {
    assert.ok(out.value.length <= 220, `summary length ${out.value.length} should be ≤ 220`);
    assert.ok(!out.value.includes('\n'), 'summary must be single line');
    assert.match(out.value, /^planner \[error\]: line1 line2 x+$/);
  }
});

test('worker tool: toModelOutput bounds a verbose draft commit message and strips newlines', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const { tools } = makeWorkerTools();
  const t = makeWorkerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    workerTools: tools,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    group: baseGroup(),
  });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');
  const summary = await toModelOutput({
    toolCallId: 'tc',
    input: {},
    output: {
      kind: 'ok',
      delivery: {
        branch: 'aitm/core',
        draftCommitMessage: `feat: x\n\n${'a'.repeat(400)}`,
        changes: [{ path: 'src/a.ts', kind: 'create', summary: 'created a' }],
        progressEntries: [],
      },
    },
  });
  assert.equal(summary.type, 'text');
  if (summary.type === 'text') {
    assert.ok(summary.value.length <= 220);
    assert.ok(!summary.value.includes('\n'));
    assert.ok(summary.value.startsWith('worker [ok]: aitm/core — feat: x '));
  }
});

test('reviewer tool: toModelOutput collapses zero-resolution ok, blocked + error results', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const { tools } = makeReviewerTools();
  const t = makeReviewerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    reviewerTools: tools,
    checkoutPath: '/tmp/wt',
    pr: 1,
    threads: [],
  });
  const toModelOutput = t.toModelOutput;
  if (typeof toModelOutput !== 'function') throw new Error('no toModelOutput');

  const empty = await toModelOutput({
    toolCallId: 'tc',
    input: {},
    output: { kind: 'ok', resolutions: [] },
  });
  assert.equal(empty.type, 'text');
  if (empty.type === 'text') assert.match(empty.value, /^reviewer \[ok\]: 0 resolution\(s\)$/);

  const blocked = await toModelOutput({
    toolCallId: 'tc',
    input: {},
    output: { kind: 'blocked', reason: 'no threads' } as never,
  });
  assert.equal(blocked.type, 'text');
  if (blocked.type === 'text') assert.match(blocked.value, /^reviewer \[blocked\]: no threads$/);

  const err = await toModelOutput({
    toolCallId: 'tc',
    input: {},
    output: { kind: 'error', error: 'gh failed' },
  });
  assert.equal(err.type, 'text');
  if (err.type === 'text') assert.match(err.value, /^reviewer \[error\]: gh failed$/);
});

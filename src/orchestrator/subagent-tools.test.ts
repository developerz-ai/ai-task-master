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
    tasks: ['task A'],
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
    worktreePath: '/tmp/wt',
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
    worktreePath: '/tmp/wt',
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
  const model = modelEmitting(JSON.stringify(plan));
  const { provider, calls } = recordingProvider(model);
  const t = makePlannerTool({
    credentials: provider,
    styleContents: '# style\n',
    rollingContext: '',
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
  const { provider } = recordingProvider(modelEmitting(JSON.stringify(plan)));
  const t = makePlannerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
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
  // First call returns the manifest JSON, second is the editor summary.
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const text = i++ === 0 ? JSON.stringify(manifest) : 'created x';
      return {
        content: [{ type: 'text', text }],
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
    worktreePath: '/tmp/wt',
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
  assert.equal(bashes.length, 3);
  assert.match(bashes[0]?.command ?? '', /checkout -B 'aitm\/core'/);
});

test('worker tool: toModelOutput collapses ok result to "worker [ok]: …"', async () => {
  const { provider } = recordingProvider(new MockLanguageModelV3());
  const { tools } = makeWorkerTools();
  const t = makeWorkerTool({
    credentials: provider,
    styleContents: '',
    rollingContext: '',
    workerTools: tools,
    worktreePath: '/tmp/wt',
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
    worktreePath: '/tmp/wt',
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
    doGenerate: async () => {
      const next = outputs[i++] ?? { kind: 'replied' };
      return {
        content: [{ type: 'text', text: JSON.stringify(next) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { provider, calls } = recordingProvider(model);
  const { tools } = makeReviewerTools();
  const t = makeReviewerTool({
    credentials: provider,
    styleContents: '# style\n',
    rollingContext: '',
    reviewerTools: tools,
    worktreePath: '/tmp/wt',
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
    worktreePath: '/tmp/wt',
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
    worktreePath: '/tmp/wt',
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
    worktreePath: '/tmp/wt',
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

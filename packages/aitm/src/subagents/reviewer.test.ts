import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { ReviewThread } from '../github/schema.ts';
import {
  createReviewerAgent,
  type GithubToolInput,
  type GithubToolOutput,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerTools,
  runReviewer,
  type ThreadResolutionOutput,
} from './reviewer.ts';
import type {
  BashInput,
  BashOutput,
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
} from './worker.ts';

function emptyUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
    totalTokens: 2,
  };
}

// One agent.generate per thread; the agent delivers each resolution via the submit tool-call.
function makeReviewerModel(outputs: ThreadResolutionOutput[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const idx = i++;
      const next = outputs[idx] ?? { kind: 'replied' };
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${idx}`,
            toolName: 'submit',
            input: JSON.stringify(next),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
}

type ToolCalls = {
  reads: ReadFileInput[];
  writes: WriteFileInput[];
  bashes: BashInput[];
  githubs: GithubToolInput[];
};

function makeTools(
  opts: {
    bashStdout?: (command: string) => string;
    bashExitCode?: number;
    bashStderr?: string;
  } = {},
): { tools: ReviewerTools; calls: ToolCalls } {
  const calls: ToolCalls = { reads: [], writes: [], bashes: [], githubs: [] };
  const tools: ReviewerTools = {
    readFile: tool<ReadFileInput, ReadFileOutput>({
      description: 'read a file from the worktree',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => {
        calls.reads.push(input);
        return { content: '' };
      },
    }),
    writeFile: tool<WriteFileInput, WriteFileOutput>({
      description: 'write a file in the worktree',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async (input) => {
        calls.writes.push(input);
        return { ok: true };
      },
    }),
    bash: tool<BashInput, BashOutput>({
      description: 'run a bash command in the worktree',
      inputSchema: z.object({ command: z.string() }),
      execute: async (input) => {
        calls.bashes.push(input);
        const stdout = opts.bashStdout?.(input.command) ?? '';
        return {
          stdout,
          stderr: opts.bashStderr ?? '',
          exitCode: opts.bashExitCode ?? 0,
        };
      },
    }),
    github: tool<GithubToolInput, GithubToolOutput>({
      description: 'reply to or resolve a PR review thread',
      inputSchema: z.discriminatedUnion('action', [
        z.object({
          action: z.literal('replyToThread'),
          threadId: z.string(),
          body: z.string(),
        }),
        z.object({ action: z.literal('resolveThread'), threadId: z.string() }),
      ]),
      execute: async (input) => {
        calls.githubs.push(input);
        return { ok: true };
      },
    }),
  };
  return { tools, calls };
}

function thread(id: string, body: string): ReviewThread {
  return {
    id,
    isResolved: false,
    path: 'src/example.ts',
    comments: [{ id: `${id}-c1`, body, author: 'reviewer' }],
  };
}

function baseInput(threads: ReviewThread[]): {
  pr: number;
  threads: ReviewThread[];
  worktreePath: string;
  styleContents: string;
} {
  return { pr: 42, threads, worktreePath: '/tmp/wt', styleContents: '# style\n' };
}

test('REVIEWER_SYSTEM_PREFIX names the three outcomes', () => {
  assert.match(REVIEWER_SYSTEM_PREFIX, /"fixed"/);
  assert.match(REVIEWER_SYSTEM_PREFIX, /"replied"/);
  assert.match(REVIEWER_SYSTEM_PREFIX, /"wontfix"/);
});

test('REVIEWER_SYSTEM_PREFIX carries the compaction continuation contract (issue #102)', () => {
  assert.match(REVIEWER_SYSTEM_PREFIX, /summarized/i);
  assert.match(REVIEWER_SYSTEM_PREFIX, /continue from that summary/i);
  assert.match(REVIEWER_SYSTEM_PREFIX, /do not\s+wrap up early/i);
});

test('createReviewerAgent builds an agent that exposes the injected tools', () => {
  const { tools } = makeTools();
  const agent = createReviewerAgent({
    model: new MockLanguageModelV3(),
    tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
  });
  assert.ok(agent);
  // The factory registers the injected tools plus the terminal submit tool.
  assert.deepEqual(Object.keys(agent.tools).sort(), [...Object.keys(tools), 'submit'].sort());
  assert.strictEqual(agent.tools.github, tools.github);
});

test('createReviewerAgent forwards timeout → a stalled step surfaces as a deadline error (issue #129)', async () => {
  const { tools } = makeTools();
  const stalling = new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
  const agent = createReviewerAgent({
    model: stalling,
    tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
    timeout: { stepMs: 40 },
  });
  const result = await runReviewer(agent, baseInput([thread('T1', 'please rename this variable')]));
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.error, /exceeded the configured deadline/);
});

test('runReviewer yields one resolution per thread, mixed fixed/replied/wontfix', async () => {
  const outputs: ThreadResolutionOutput[] = [
    { kind: 'fixed', commitMessage: 'fix: rename variable' },
    { kind: 'replied' },
    { kind: 'wontfix', reason: 'out of scope for this PR' },
  ];
  const { tools, calls } = makeTools({
    bashStdout: (cmd) => (cmd.includes('rev-parse HEAD') ? 'abcdef1234567890\n' : ''),
  });
  const model = makeReviewerModel(outputs);
  const agent = createReviewerAgent({ model, tools, systemPrompt: REVIEWER_SYSTEM_PREFIX });

  const result = await runReviewer(
    agent,
    baseInput([
      thread('T1', 'please rename this variable'),
      thread('T2', 'why is this here?'),
      thread('T3', 'rename Foo to Bar'),
    ]),
  );

  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  assert.equal(result.resolutions.length, 3);
  assert.deepEqual(result.resolutions[0], {
    threadId: 'T1',
    kind: 'fixed',
    commitSha: 'abcdef1234567890',
  });
  assert.deepEqual(result.resolutions[1], { threadId: 'T2', kind: 'replied' });
  assert.deepEqual(result.resolutions[2], {
    threadId: 'T3',
    kind: 'wontfix',
    reason: 'out of scope for this PR',
  });

  // Exactly one commit sequence — only the 'fixed' thread drives bash calls.
  assert.equal(calls.bashes.length, 3);
  const cmds = calls.bashes.map((b) => b.command);
  assert.match(cmds[0] ?? '', /git -C '\/tmp\/wt' add -A/);
  assert.match(cmds[1] ?? '', /git -C '\/tmp\/wt' commit -m 'fix: rename variable'/);
  assert.match(cmds[2] ?? '', /git -C '\/tmp\/wt' rev-parse HEAD/);
});

test('runReviewer returns ok with no resolutions when threads is empty', async () => {
  const { tools, calls } = makeTools();
  const agent = createReviewerAgent({
    model: new MockLanguageModelV3(),
    tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
  });
  const result = await runReviewer(agent, baseInput([]));
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.deepEqual(result.resolutions, []);
  }
  assert.equal(calls.bashes.length, 0);
});

test('runReviewer: a thread whose submission never validates resolves wontfix without aborting the rest (issue #101)', async () => {
  const { tools } = makeTools();
  // Thread 1 submits an out-of-enum `kind` on every attempt (3 calls: initial + 2 retries), so the
  // schema-retry kernel exhausts; thread 2 then submits a valid resolution on its first call.
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const idx = i++;
      const input = idx < 3 ? { kind: 'bogus' } : { kind: 'replied' };
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `submit-${idx}`,
            toolName: 'submit',
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createReviewerAgent({ model, tools, systemPrompt: REVIEWER_SYSTEM_PREFIX });
  const result = await runReviewer(agent, baseInput([thread('T1', 'hmm'), thread('T2', 'ok?')]));

  // The bad thread no longer throws / aborts — the run completes and BOTH threads are resolved.
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.equal(result.resolutions.length, 2);
    const t1 = result.resolutions.find((r) => r.threadId === 'T1');
    assert.equal(t1?.kind, 'wontfix');
    if (t1?.kind === 'wontfix') assert.match(t1.reason, /schema validation after retries/i);
    assert.equal(result.resolutions.find((r) => r.threadId === 'T2')?.kind, 'replied');
  }
});

test('runReviewer returns error when bash fails during the fixed-thread commit', async () => {
  const outputs: ThreadResolutionOutput[] = [{ kind: 'fixed', commitMessage: 'fix: nope' }];
  const { tools } = makeTools({ bashExitCode: 1, bashStderr: 'nothing to commit' });
  const model = makeReviewerModel(outputs);
  const agent = createReviewerAgent({ model, tools, systemPrompt: REVIEWER_SYSTEM_PREFIX });
  const result = await runReviewer(agent, baseInput([thread('T1', 'fix this')]));
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /bash failed \(1\)/);
    assert.match(result.error, /nothing to commit/);
  }
});

test('runReviewer rejects an agent not built by createReviewerAgent', async () => {
  const result = await runReviewer({} as never, baseInput([thread('T1', 'fix this')]));
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /not built by createReviewerAgent/);
  }
});

test('runReviewer processes threads sequentially in input order', async () => {
  const outputs: ThreadResolutionOutput[] = [
    { kind: 'replied' },
    { kind: 'replied' },
    { kind: 'replied' },
  ];
  const order: string[] = [];
  const baseModel = makeReviewerModel(outputs);
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const promptText = JSON.stringify(opts.prompt);
      const match = /Thread id: (T\d)/.exec(promptText);
      if (match?.[1]) order.push(match[1]);
      return baseModel.doGenerate(opts);
    },
  });
  const { tools } = makeTools();
  const agent = createReviewerAgent({ model, tools, systemPrompt: REVIEWER_SYSTEM_PREFIX });
  const result = await runReviewer(
    agent,
    baseInput([thread('T1', 'a'), thread('T2', 'b'), thread('T3', 'c')]),
  );
  assert.equal(result.kind, 'ok');
  assert.deepEqual(order, ['T1', 'T2', 'T3']);
});

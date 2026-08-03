import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BashInput,
  BashOutput,
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
} from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { ReviewThread } from '../github/schema.ts';
import { emptyUsage } from '../testing/model-fixtures.ts';
import { stallingModel } from '../testing/stalling-model.ts';
import { reviewerTools } from '../testing/subagent-tools.ts';
import type { GithubToolInput, GithubToolOutput } from '../tools/github-thread-tool.ts';
import { render } from './prompts/templates.ts';
import {
  createReviewerAgent,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerTools,
  runReviewer,
  type ThreadResolutionOutput,
} from './reviewer.ts';

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

// `git diff --cached --quiet` is the reviewer's empty-index probe: exit 0 = nothing staged, 1 =
// staged changes. Default it to 1 (a real fix stages something) so the commit path runs; `stagedEmpty`
// flips it to 0 to exercise the no-op downgrade. An explicit `bashExitCode` still wins (failure paths).
function bashExit(command: string, opts: { bashExitCode?: number; stagedEmpty?: boolean }): number {
  if (opts.bashExitCode !== undefined) return opts.bashExitCode;
  if (command.includes('diff --cached --quiet')) return opts.stagedEmpty ? 0 : 1;
  return 0;
}

function makeTools(
  opts: {
    bashStdout?: (command: string) => string;
    bashExitCode?: number;
    bashStderr?: string;
    stagedEmpty?: boolean;
  } = {},
): { tools: ReviewerTools; calls: ToolCalls } {
  const calls: ToolCalls = { reads: [], writes: [], bashes: [], githubs: [] };
  const tools: ReviewerTools = reviewerTools({
    readFile: tool<ReadFileInput, ReadFileOutput>({
      description: 'read a file from the checkout',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => {
        calls.reads.push(input);
        return { content: '' };
      },
    }),
    writeFile: tool<WriteFileInput, WriteFileOutput>({
      description: 'write a file in the checkout',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async (input) => {
        calls.writes.push(input);
        return { ok: true };
      },
    }),
    bash: tool<BashInput, BashOutput>({
      description: 'run a bash command in the checkout',
      inputSchema: z.object({
        command: z.string(),
        description: z.string(),
        timeoutMs: z.number().optional(),
        run_in_background: z.boolean().optional(),
      }),
      execute: async (input) => {
        calls.bashes.push(input);
        const stdout = opts.bashStdout?.(input.command) ?? '';
        return {
          stdout,
          stderr: opts.bashStderr ?? '',
          exitCode: bashExit(input.command, opts),
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
  });
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
  checkoutPath: string;
  styleContents: string;
} {
  return { pr: 42, threads, checkoutPath: '/tmp/wt', styleContents: '# style\n' };
}

test('REVIEWER_SYSTEM_PREFIX names the three outcomes', () => {
  assert.match(REVIEWER_SYSTEM_PREFIX, /"fixed"/);
  assert.match(REVIEWER_SYSTEM_PREFIX, /"replied"/);
  assert.match(REVIEWER_SYSTEM_PREFIX, /"wontfix"/);
});

test("the Reviewer's rendered prompt carries the compaction continuation contract (issue #102)", () => {
  // The contract moved from this role's prose into the shared contextManagement block — it is
  // cross-cutting. Assert on what the Reviewer actually receives, not on where the sentence lives.
  const rendered = render('role-prompt', {
    roleGuidance: REVIEWER_SYSTEM_PREFIX,
    style: '',
    env: '<env>\n</env>',
  });
  assert.match(rendered, /summarized/i);
  assert.match(rendered, /resume from the summary/i);
  assert.match(rendered, /do not re-plan from scratch/i);
});

test('REVIEWER_SYSTEM_PREFIX tells the model to disagree when the comment is wrong (§2d)', () => {
  assert.match(REVIEWER_SYSTEM_PREFIX, /Disagree when the comment is wrong/);
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
  const stalling = stallingModel();
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

  // T1's commit sequence (only the 'fixed' thread stages/commits), then a between-thread stray-edit
  // sweep after each of the three threads. The empty-index probe (`diff --cached --quiet`) sits
  // between staging and the commit; the tree is clean here, so each sweep is just a status probe.
  assert.equal(calls.bashes.length, 8);
  const cmds = calls.bashes.map((b) => b.command);
  assert.match(cmds[0] ?? '', /git -C '\/tmp\/wt' add -A/);
  assert.match(cmds[1] ?? '', /reset -q -- \.ai-task-master/);
  assert.match(cmds[2] ?? '', /git -C '\/tmp\/wt' diff --cached --quiet/);
  assert.match(cmds[3] ?? '', /git -C '\/tmp\/wt' commit -m 'fix: rename variable'/);
  assert.match(cmds[4] ?? '', /git -C '\/tmp\/wt' rev-parse HEAD/);
  assert.match(cmds[5] ?? '', /git -C '\/tmp\/wt' status --porcelain/);
  assert.match(cmds[6] ?? '', /git -C '\/tmp\/wt' status --porcelain/);
  assert.match(cmds[7] ?? '', /git -C '\/tmp\/wt' status --porcelain/);
});

test("runReviewer: a prior thread's stray edits are swept before the next thread's fix commit (task #58)", async () => {
  // T1 replies but leaves an uncommitted edit (leaked.ts); T2 then fixes real code. Without the
  // between-thread sweep, T2's `git add -A` would stage leaked.ts into the fix commit. The sweep
  // (`reset --hard` + `clean`) must run after T1 and before T2 stages.
  const outputs: ThreadResolutionOutput[] = [
    { kind: 'replied' },
    { kind: 'fixed', commitMessage: 'fix: real change' },
  ];
  let statusCalls = 0;
  const { tools, calls } = makeTools({
    bashStdout: (cmd) => {
      if (cmd.includes('status --porcelain')) {
        statusCalls += 1;
        // Dirty right after T1 (the leaked stray edit); clean again after T2's own commit.
        return statusCalls === 1 ? ' M leaked.ts\n' : '';
      }
      return cmd.includes('rev-parse HEAD') ? 'facef00dfacef00d\n' : '';
    },
  });
  const agent = createReviewerAgent({
    model: makeReviewerModel(outputs),
    tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
  });

  const result = await runReviewer(
    agent,
    baseInput([thread('T1', 'why?'), thread('T2', 'fix this')]),
  );

  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.deepEqual(result.resolutions[0], { threadId: 'T1', kind: 'replied' });
    assert.deepEqual(result.resolutions[1], {
      threadId: 'T2',
      kind: 'fixed',
      commitSha: 'facef00dfacef00d',
    });
  }

  const cmds = calls.bashes.map((b) => b.command);
  // The sweep after T1: a dirty status probe drives `reset --hard` + `clean` (state dir spared).
  const sweep = cmds.findIndex((c) => /status --porcelain/.test(c));
  assert.ok(sweep >= 0, 'a between-thread status probe runs');
  assert.match(cmds[sweep + 1] ?? '', /reset --hard HEAD/);
  assert.match(cmds[sweep + 2] ?? '', /clean -fd -e \.ai-task-master/);
  // T2 stages its fix only AFTER the sweep, so leaked.ts can never reach the commit.
  const addIdx = cmds.findIndex((c) => /add -A/.test(c));
  assert.ok(addIdx > sweep + 2, 'the stray sweep precedes the next fix commit');
});

test('runReviewer: commitFix asserts the PR head branch, then commits when the tree is on it (audit 02)', async () => {
  const outputs: ThreadResolutionOutput[] = [{ kind: 'fixed', commitMessage: 'fix: on head' }];
  const { tools, calls } = makeTools({
    bashStdout: (cmd) =>
      cmd.includes('rev-parse --abbrev-ref HEAD')
        ? 'aitm/g1\n'
        : cmd.includes('rev-parse HEAD')
          ? 'deadbeefcafef00d\n'
          : '',
  });
  const agent = createReviewerAgent({
    model: makeReviewerModel(outputs),
    tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
  });
  const result = await runReviewer(agent, {
    ...baseInput([thread('T1', 'fix this')]),
    headBranch: 'aitm/g1',
  });

  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.deepEqual(result.resolutions[0], {
      threadId: 'T1',
      kind: 'fixed',
      commitSha: 'deadbeefcafef00d',
    });
  }
  // The head-branch assertion is the FIRST git call, before any staging; the empty-index probe
  // precedes the commit.
  const cmds = calls.bashes.map((b) => b.command);
  assert.match(cmds[0] ?? '', /rev-parse --abbrev-ref HEAD/);
  assert.match(cmds[1] ?? '', /git -C '\/tmp\/wt' add -A/);
  assert.match(cmds[3] ?? '', /diff --cached --quiet/);
  assert.match(cmds[4] ?? '', /commit -m 'fix: on head'/);
});

test('runReviewer: commitFix refuses to commit when the tree is on the wrong branch (audit 02)', async () => {
  const outputs: ThreadResolutionOutput[] = [{ kind: 'fixed', commitMessage: 'fix: wrong branch' }];
  const { tools, calls } = makeTools({
    bashStdout: (cmd) => (cmd.includes('rev-parse --abbrev-ref HEAD') ? 'some-other-branch\n' : ''),
  });
  const agent = createReviewerAgent({
    model: makeReviewerModel(outputs),
    tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
  });
  const result = await runReviewer(agent, {
    ...baseInput([thread('T1', 'fix this')]),
    headBranch: 'aitm/g1',
  });

  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /refusing to commit/);
    assert.match(result.error, /some-other-branch/);
    assert.match(result.error, /aitm\/g1/);
  }
  // It bailed at the assertion: no add/commit was attempted on the wrong branch.
  const cmds = calls.bashes.map((b) => b.command);
  assert.equal(cmds.length, 1);
  assert.ok(!cmds.some((c) => /add -A|commit -m/.test(c)));
});

test('runReviewer: a commitFix throw at thread N keeps resolutions 1..N-1 (durability #4)', async () => {
  // T1 replied and T2 wontfix are already resolved on GitHub before T3's "fixed" reaches commitFix,
  // which refuses (tree on the wrong branch) and throws. The pass errors, but the two earlier
  // resolutions must survive on the error result so the caller records them as addressed — otherwise
  // a resume re-feeds T1/T2 and the Reviewer duplicates the replies.
  const outputs: ThreadResolutionOutput[] = [
    { kind: 'replied' },
    { kind: 'wontfix', reason: 'stale' },
    { kind: 'fixed', commitMessage: 'fix: too late' },
  ];
  const { tools, calls } = makeTools({
    bashStdout: (cmd) => (cmd.includes('rev-parse --abbrev-ref HEAD') ? 'wrong-branch\n' : ''),
  });
  const agent = createReviewerAgent({
    model: makeReviewerModel(outputs),
    tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
  });
  const result = await runReviewer(agent, {
    ...baseInput([thread('T1', 'a'), thread('T2', 'b'), thread('T3', 'fix this')]),
    headBranch: 'aitm/g1',
  });

  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /refusing to commit/);
    assert.deepEqual(result.resolutions, [
      { threadId: 'T1', kind: 'replied' },
      { threadId: 'T2', kind: 'wontfix', reason: 'stale' },
    ]);
  }
  // T1/T2 didn't commit, but each still gets a between-thread stray-edit sweep (a clean status probe
  // here). T3 then hits the branch check and refuses before staging — no add/commit on the wrong branch.
  const cmds = calls.bashes.map((b) => b.command);
  assert.equal(cmds.length, 3);
  assert.match(cmds[0] ?? '', /status --porcelain/);
  assert.match(cmds[1] ?? '', /status --porcelain/);
  assert.match(cmds[2] ?? '', /rev-parse --abbrev-ref HEAD/);
  assert.ok(!cmds.some((c) => /add -A|commit -m/.test(c)));
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

test('runReviewer: an empty-diff "fixed" thread downgrades to wontfix and keeps the other resolutions (audit 03)', async () => {
  // T1 says "fixed" but stages nothing (stagedEmpty ⇒ `git diff --cached --quiet` exits 0). Pre-guard
  // that threw "nothing to commit" and — under the pass-wide try/catch — discarded T2's resolution too.
  const outputs: ThreadResolutionOutput[] = [
    { kind: 'fixed', commitMessage: 'fix: no-op' },
    { kind: 'replied' },
  ];
  const { tools, calls } = makeTools({ stagedEmpty: true });
  const agent = createReviewerAgent({
    model: makeReviewerModel(outputs),
    tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
  });
  const result = await runReviewer(
    agent,
    baseInput([thread('T1', 'please fix this'), thread('T2', 'why is this here?')]),
  );

  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.equal(result.resolutions.length, 2);
    const t1 = result.resolutions.find((r) => r.threadId === 'T1');
    assert.equal(t1?.kind, 'wontfix');
    if (t1?.kind === 'wontfix') assert.match(t1.reason, /no staged changes|nothing to commit/i);
    // The other thread's resolution survives — the empty diff did not abort the pass.
    assert.deepEqual(
      result.resolutions.find((r) => r.threadId === 'T2'),
      { threadId: 'T2', kind: 'replied' },
    );
  }

  // The no-op thread stages and probes but never commits: add + reset + diff, no commit / rev-parse.
  // A between-thread stray-edit sweep (a clean status probe) then follows each of the two threads.
  const cmds = calls.bashes.map((b) => b.command);
  assert.equal(calls.bashes.length, 5);
  assert.match(cmds[0] ?? '', /git -C '\/tmp\/wt' add -A/);
  assert.match(cmds[1] ?? '', /reset -q -- \.ai-task-master/);
  assert.match(cmds[2] ?? '', /git -C '\/tmp\/wt' diff --cached --quiet/);
  assert.match(cmds[3] ?? '', /status --porcelain/);
  assert.match(cmds[4] ?? '', /status --porcelain/);
  assert.ok(!cmds.some((c) => /commit -m/.test(c)));
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

test('createReviewerAgent forwards the run signal → an abort cancels the in-flight thread resolution', async () => {
  const stalling = stallingModel();
  const controller = new AbortController();
  const agent = createReviewerAgent({
    model: stalling,
    tools: makeTools().tools,
    systemPrompt: REVIEWER_SYSTEM_PREFIX,
    signal: controller.signal,
    // Safety net: an unwired signal must fail the test rather than hang it forever.
    timeout: { stepMs: 2_000 },
  });
  setTimeout(() => controller.abort(), 5);
  const result = await runReviewer(agent, {
    ...baseInput([thread('T1', 'fix this')]),
    headBranch: 'aitm/g1',
  });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /abort/i);
    assert.doesNotMatch(result.error, /deadline/, 'a cancel is never a deadline breach');
  }
});

test('runReviewer: an investigation brief reaches that thread only, as leads not a verdict', async () => {
  // The review team (review-team.ts) works the threads out in parallel BEFORE this sequential pass;
  // its brief is what stops the resolver re-deriving the same location one thread at a time. A
  // thread with no brief must stay byte-identical to the pre-team prompt.
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      prompts.push(JSON.stringify(opts.prompt));
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-x',
            toolName: 'submit',
            input: JSON.stringify({ kind: 'replied' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools({});
  const agent = createReviewerAgent({ model, tools, systemPrompt: REVIEWER_SYSTEM_PREFIX });

  const result = await runReviewer(agent, {
    ...baseInput([thread('T1', 'this leaks the token'), thread('T2', 'why is this here?')]),
    briefs: new Map([
      ['T1', '<investigation>\ntoken is redacted at src/log.ts:20\n</investigation>'],
    ]),
  });

  assert.equal(result.kind, 'ok');
  assert.match(prompts[0] ?? '', /token is redacted at src\/log\.ts:20/);
  assert.doesNotMatch(
    prompts[1] ?? '',
    /investigation/,
    'an unbriefed thread is prompted as before',
  );
});

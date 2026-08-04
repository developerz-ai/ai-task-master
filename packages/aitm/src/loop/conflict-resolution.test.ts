import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonSchema } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { AGENT_STEP_BACKSTOP } from '../subagents/factory.ts';
import type { WorkerTools } from '../subagents/worker.ts';
import { stallingModel } from '../testing/stalling-model.ts';
import { workerTools } from '../testing/subagent-tools.ts';
import { buildConflictResolver, CONFLICT_RESOLVER_MAX_STEPS } from './conflict-resolution.ts';
import { deferredPrepareStep } from './tool-resolution.ts';

type Captured = { prompt: string; system: string };

// A model that returns a plain text turn and stops — no tool calls, so generateText completes in one
// step. `capture` receives the JSON-serialized request (full prompt + the system messages) so tests
// can assert what the resolver asked the model to do.
function textModel(
  text = 'resolved the conflict',
  capture?: (c: Captured) => void,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      capture?.({
        prompt: JSON.stringify(opts.prompt),
        system: JSON.stringify(opts.prompt.filter((m) => m.role === 'system')),
      });
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
          totalTokens: 2,
        },
        warnings: [],
      };
    },
  });
}

test('buildConflictResolver: model completes → resolved; usage reported', async () => {
  let usageCalls = 0;
  const resolver = buildConflictResolver({
    model: textModel(),
    tools: {} as WorkerTools,
    styleContents: '',
    onUsage: () => {
      usageCalls++;
    },
  });
  const result = await resolver({
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    conflictedFiles: ['src/a.ts'],
    attempt: 1,
  });
  assert.equal(result.kind, 'resolved');
  assert.equal(usageCalls, 1, 'usage sink fired once for the resolution pass');
});

test('buildConflictResolver: prompt lists the conflicted files; system prompt forbids continue/abort', async () => {
  let cap: Captured = { prompt: '', system: '' };
  const resolver = buildConflictResolver({
    model: textModel('done', (c) => {
      cap = c;
    }),
    tools: {} as WorkerTools,
    styleContents: '',
  });
  await resolver({
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    conflictedFiles: ['src/a.ts', 'src/b.ts'],
    attempt: 1,
  });
  assert.match(cap.prompt, /src\/a\.ts/);
  assert.match(cap.prompt, /src\/b\.ts/);
  assert.match(cap.prompt, /origin\/main/);
  // The rebase state machine is the harness's; the resolver must be told not to drive it.
  assert.match(cap.system, /git rebase --continue/);
  assert.match(cap.system, /git add/);
});

test('buildConflictResolver: second attempt prompt notes the prior pass left files unmerged', async () => {
  let cap: Captured = { prompt: '', system: '' };
  const resolver = buildConflictResolver({
    model: textModel('done', (c) => {
      cap = c;
    }),
    tools: {} as WorkerTools,
    styleContents: '',
  });
  await resolver({
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    conflictedFiles: ['src/a.ts'],
    attempt: 2,
  });
  assert.match(cap.prompt, /attempt 2/i);
});

test('buildConflictResolver: a stalled/aborted generate → unresolved carrying the reason', async () => {
  const stalling = stallingModel();
  const resolver = buildConflictResolver({
    model: stalling,
    tools: {} as WorkerTools,
    styleContents: '',
    timeout: { stepMs: 40 },
  });
  const result = await resolver({
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    conflictedFiles: ['src/a.ts'],
    attempt: 1,
  });
  assert.equal(result.kind, 'unresolved');
  if (result.kind === 'unresolved') assert.match(result.reason, /exceeded the configured deadline/);
});

test('CONFLICT_RESOLVER_MAX_STEPS is the shared runaway backstop, not a low work cap', () => {
  // The resolver terminates when it submits; the cap only guards a non-terminating loop, so it sits
  // far above any real resolution (see AGENT_STEP_BACKSTOP) rather than at a low 20-30.
  assert.equal(CONFLICT_RESOLVER_MAX_STEPS, AGENT_STEP_BACKSTOP);
});

test('buildConflictResolver: an activation step filters the deferred surface per step (issue #339)', async () => {
  // The resolver runs on the Worker's record, so once that record carries a deferred MCP surface,
  // every unactivated tool's full schema rides along in each conflict request unless the caller
  // hands over the same activation step the Worker itself uses.
  const offered: string[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      offered.push((opts.tools ?? []).map((t) => t.name).sort());
      return {
        content: [{ type: 'text' as const, text: 'resolved' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
          totalTokens: 2,
        },
        warnings: [],
      };
    },
  });
  const tools = {
    ...workerTools(),
    mcp__gh__x: { description: 'a deferred tool', inputSchema: jsonSchema({ type: 'object' }) },
  } as WorkerTools;
  const mount = {
    extraTools: {},
    indexBlock: 'idx',
    deferredNames: new Set(['mcp__gh__x']),
    activated: new Set<string>(),
  };
  const resolve = buildConflictResolver({
    model,
    tools,
    styleContents: '',
    prepareStep: deferredPrepareStep<WorkerTools>(undefined, mount, tools),
  });
  await resolve({
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    conflictedFiles: ['a.ts'],
    attempt: 1,
  });

  assert.ok(offered.length > 0, 'the resolver generated');
  assert.equal(
    offered[0]?.includes('mcp__gh__x'),
    false,
    'the unactivated deferred tool is withheld from the conflict request',
  );
  assert.ok(offered[0]?.includes('readFile'), 'the fixed slots still reach it');
});

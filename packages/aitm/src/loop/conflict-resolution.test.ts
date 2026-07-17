import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { WorkerTools } from '../subagents/worker.ts';
import { buildConflictResolver, CONFLICT_RESOLVER_MAX_STEPS } from './conflict-resolution.ts';

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
  const stalling = new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
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

test('CONFLICT_RESOLVER_MAX_STEPS is a small positive bound', () => {
  assert.ok(CONFLICT_RESOLVER_MAX_STEPS > 0 && CONFLICT_RESOLVER_MAX_STEPS <= 30);
});

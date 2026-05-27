import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type GithubThreadClient, githubThreadTool } from './github-thread-tool.ts';

type Call = { method: 'reply' | 'resolve'; threadId: string; body?: string };

function recorder(): { calls: Call[]; github: GithubThreadClient } {
  const calls: Call[] = [];
  return {
    calls,
    github: {
      replyToThread: async (threadId, body) => {
        calls.push({ method: 'reply', threadId, body });
      },
      resolveThread: async (threadId) => {
        calls.push({ method: 'resolve', threadId });
      },
    },
  };
}

async function run<I, O>(t: { execute?: unknown }, input: I): Promise<O> {
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('tool has no execute');
  return (await (exec as (i: I, o: { toolCallId: string; messages: never[] }) => Promise<O>)(
    input,
    {
      toolCallId: 'test',
      messages: [],
    },
  )) as O;
}

test('githubThreadTool: replyToThread invokes client.replyToThread with body', async () => {
  const rec = recorder();
  const tool = githubThreadTool({ github: rec.github });
  const out = await run(tool, {
    action: 'replyToThread',
    threadId: 'TH_1',
    body: 'fixed via commit abc',
  });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(rec.calls, [
    { method: 'reply', threadId: 'TH_1', body: 'fixed via commit abc' },
  ]);
});

test('githubThreadTool: resolveThread invokes client.resolveThread', async () => {
  const rec = recorder();
  const tool = githubThreadTool({ github: rec.github });
  const out = await run(tool, { action: 'resolveThread', threadId: 'TH_2' });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(rec.calls, [{ method: 'resolve', threadId: 'TH_2' }]);
});

test('githubThreadTool: input schema rejects unknown action at parse time', () => {
  const tool = githubThreadTool({ github: recorder().github });
  // The SDK calls inputSchema.parse on the model's output before invoking execute.
  // Reach into the tool's exposed schema and assert it would reject malformed input —
  // that's the actual guarantee end-to-end, not anything execute can enforce alone.
  const schema = (tool as { inputSchema?: { safeParse?: (v: unknown) => { success: boolean } } })
    .inputSchema;
  assert.ok(schema?.safeParse, 'tool must carry an inputSchema');
  assert.equal(schema.safeParse({ action: 'unknown', threadId: 'x' }).success, false);
  assert.equal(schema.safeParse({ action: 'replyToThread', threadId: 'x' }).success, false);
  assert.equal(
    schema.safeParse({ action: 'replyToThread', threadId: 'x', body: 'ok' }).success,
    true,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkLoop } from './work-loop.ts';

test('WorkLoop is constructible (skeleton)', () => {
  const loop = new WorkLoop({
    orchestrator: {} as never,
    github: {} as never,
    state: {} as never,
    pool: {} as never,
    graph: {} as never,
    concurrency: 1,
    autoMerge: true,
    maxSessions: null,
  });
  assert.ok(loop instanceof WorkLoop);
});

test('WorkLoop.run throws until implemented', async () => {
  const loop = new WorkLoop({
    orchestrator: {} as never,
    github: {} as never,
    state: {} as never,
    pool: {} as never,
    graph: {} as never,
    concurrency: 1,
    autoMerge: true,
    maxSessions: null,
  });
  await assert.rejects(() => loop.run());
});

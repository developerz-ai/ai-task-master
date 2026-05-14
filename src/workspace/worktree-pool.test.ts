import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorktreePool } from './worktree-pool.ts';

test('WorktreePool is constructible (skeleton)', () => {
  const p = new WorktreePool('/tmp/repo', '/tmp/repo/.ai-task-master', 2);
  assert.ok(p instanceof WorktreePool);
});

test('WorktreePool.acquire throws until implemented', async () => {
  const p = new WorktreePool('/tmp/repo', '/tmp/repo/.ai-task-master', 2);
  await assert.rejects(() => p.acquire('g1', 'aitm/r1/g1', 'main'));
});

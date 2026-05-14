import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StateStore } from './state-store.ts';

test('StateStore is constructible (skeleton)', () => {
  const s = new StateStore('/tmp/repo/.ai-task-master');
  assert.ok(s instanceof StateStore);
});

test('StateStore.read throws until implemented', async () => {
  const s = new StateStore('/tmp/repo/.ai-task-master');
  await assert.rejects(() => s.read());
});

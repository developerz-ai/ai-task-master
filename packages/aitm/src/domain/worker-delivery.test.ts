import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileChange, WorkerDelivery } from './worker-delivery.ts';

test('WorkerDelivery carries a branch, draft message, file changes and progress entries', () => {
  const change: FileChange = { path: 'src/auth.ts', kind: 'modify', summary: 'add guard' };
  const delivery: WorkerDelivery = {
    branch: 'feat/auth',
    draftCommitMessage: 'feat: add auth guard',
    changes: [change],
    progressEntries: ['added guard'],
  };
  assert.equal(delivery.changes[0]?.kind, 'modify');
  assert.equal(delivery.progressEntries.length, 1);
});

test('FileChange kind is create | modify | delete', () => {
  const kinds: FileChange['kind'][] = ['create', 'modify', 'delete'];
  assert.deepEqual(kinds, ['create', 'modify', 'delete']);
});

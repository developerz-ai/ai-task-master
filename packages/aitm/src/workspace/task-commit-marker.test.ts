import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskCommitTrailer } from './task-commit-marker.ts';

test('taskCommitTrailer: formats a stable, greppable Aitm-Task-Id trailer', () => {
  assert.equal(taskCommitTrailer('t1'), 'Aitm-Task-Id: t1');
});

test('taskCommitTrailer: distinct task ids produce distinct trailers', () => {
  assert.notEqual(taskCommitTrailer('t1'), taskCommitTrailer('t2'));
});

test('taskCommitTrailer: rejects task ids containing newlines', () => {
  assert.throws(() => taskCommitTrailer('t1\nmalicious'), /contains newline/);
});

test('taskCommitTrailer: rejects task ids with multiple newlines', () => {
  assert.throws(() => taskCommitTrailer('multi\nline\nid'), /contains newline/);
});

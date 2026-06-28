import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrGroup } from '../state/schema.ts';
import { hasInterruptedGroup, normalizeResumeStatus } from './resume-normalize.ts';

function group(overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id: 'g',
    title: 'g',
    tasks: [{ id: 't1', text: 't', complexity: 'normal', done: false }],
    dependsOn: [],
    branch: 'aitm/g',
    pr: null,
    status: 'pending',
    stage: 'pending',
    ...overrides,
  };
}

test('normalizeResumeStatus resets interrupted in-progress groups to pending, preserving stage/pr', () => {
  const [g] = normalizeResumeStatus([group({ status: 'in-progress', stage: 'pr-open', pr: null })]);
  assert.equal(g?.status, 'pending');
  assert.equal(g?.stage, 'pr-open', 'fine-grained stage preserved for resume');
});

test('normalizeResumeStatus resets interrupted awaiting-pr groups to pending, preserving stage/pr', () => {
  const [g] = normalizeResumeStatus([group({ status: 'awaiting-pr', stage: 'waiting-ci', pr: 5 })]);
  assert.equal(g?.status, 'pending');
  assert.equal(g?.stage, 'waiting-ci', 'resume point preserved');
  assert.equal(g?.pr, 5, 'open PR number preserved');
});

test('normalizeResumeStatus leaves terminal and already-schedulable groups untouched', () => {
  const groups = [
    group({ id: 'a', status: 'merged', stage: 'merged', pr: 1 }),
    group({ id: 'b', status: 'blocked', stage: 'blocked' }),
    group({ id: 'c', status: 'pending', stage: 'pending' }),
  ];
  const out = normalizeResumeStatus(groups);
  assert.deepEqual(
    out.map((g) => g.status),
    ['merged', 'blocked', 'pending'],
  );
  // Unchanged groups are returned by reference (no needless churn).
  assert.equal(out[0], groups[0]);
  assert.equal(out[1], groups[1]);
  assert.equal(out[2], groups[2]);
});

test('hasInterruptedGroup detects in-progress / awaiting-pr; false otherwise', () => {
  assert.equal(hasInterruptedGroup([group({ status: 'in-progress' })]), true);
  assert.equal(hasInterruptedGroup([group({ status: 'awaiting-pr' })]), true);
  assert.equal(
    hasInterruptedGroup([
      group({ id: 'a', status: 'merged' }),
      group({ id: 'b', status: 'blocked' }),
      group({ id: 'c', status: 'pending' }),
    ]),
    false,
  );
});

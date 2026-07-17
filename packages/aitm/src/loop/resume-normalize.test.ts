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

test('normalizeResumeStatus retries a blocked group whose stage kept a real lifecycle point', () => {
  // A group blocked in the work-loop catch keeps its lifecycle stage (e.g. pr-open) — resume there.
  const [g] = normalizeResumeStatus([group({ status: 'blocked', stage: 'pr-open', pr: null })]);
  assert.equal(g?.status, 'pending', 'blocked is retried on resume');
  assert.equal(g?.stage, 'pr-open', 'a real stage is preserved so it resumes there');
});

test('normalizeResumeStatus rewinds a blocked group with terminal "blocked" stage to working', () => {
  // The stage machine collapses the real stage into 'blocked', which has no handler — rewind it.
  const [g] = normalizeResumeStatus([group({ status: 'blocked', stage: 'blocked' })]);
  assert.equal(g?.status, 'pending');
  assert.equal(g?.stage, 'working', 'terminal blocked stage rewinds to working');
});

test('normalizeResumeStatus leaves merged and already-schedulable groups untouched', () => {
  const groups = [
    group({ id: 'a', status: 'merged', stage: 'merged', pr: 1 }),
    group({ id: 'c', status: 'pending', stage: 'pending' }),
  ];
  const out = normalizeResumeStatus(groups);
  assert.deepEqual(
    out.map((g) => g.status),
    ['merged', 'pending'],
  );
  // Unchanged groups are returned by reference (no needless churn).
  assert.equal(out[0], groups[0]);
  assert.equal(out[1], groups[1]);
});

test('hasInterruptedGroup detects in-progress / awaiting-pr / blocked; false for merged+pending', () => {
  assert.equal(hasInterruptedGroup([group({ status: 'in-progress' })]), true);
  assert.equal(hasInterruptedGroup([group({ status: 'awaiting-pr' })]), true);
  assert.equal(hasInterruptedGroup([group({ status: 'blocked' })]), true);
  assert.equal(
    hasInterruptedGroup([
      group({ id: 'a', status: 'merged' }),
      group({ id: 'c', status: 'pending' }),
    ]),
    false,
  );
});

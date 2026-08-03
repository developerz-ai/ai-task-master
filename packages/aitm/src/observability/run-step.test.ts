import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrGroup } from '../domain/pr-group.ts';
import type { Task } from '../domain/task.ts';
import { makeStepCounter, phaseForStage } from './run-step.ts';

function task(id: string, done = false): Task {
  return { id, text: id, complexity: 'normal', done };
}

function group(id: string, tasks: Task[]): PrGroup {
  return {
    id,
    title: id,
    tasks,
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    stage: 'pending',
    reviewGraceApplied: false,
  };
}

const plan: PrGroup[] = [
  group('a', [task('a-1'), task('a-2')]),
  group('b', [task('b-1'), task('b-2'), task('b-3')]),
  group('c', [task('c-1')]),
];

test('group-mode counter reports the group ordinal out of total groups', () => {
  const counter = makeStepCounter(plan, false);
  assert.deepEqual(counter('a'), { unit: 'group', index: 1, total: 3 });
  assert.deepEqual(counter('b'), { unit: 'group', index: 2, total: 3 });
  assert.deepEqual(counter('c'), { unit: 'group', index: 3, total: 3 });
});

test('group-mode counter ignores the task and returns undefined for an unknown group', () => {
  const counter = makeStepCounter(plan, false);
  assert.deepEqual(counter('b', task('b-2')), { unit: 'group', index: 2, total: 3 });
  assert.equal(counter('missing'), undefined);
});

test('prPerTask counter reports the global task ordinal out of total tasks', () => {
  const counter = makeStepCounter(plan, true);
  assert.deepEqual(counter('a', task('a-1')), { unit: 'task', index: 1, total: 6 });
  assert.deepEqual(counter('a', task('a-2')), { unit: 'task', index: 2, total: 6 });
  assert.deepEqual(counter('b', task('b-1')), { unit: 'task', index: 3, total: 6 });
  assert.deepEqual(counter('b', task('b-3')), { unit: 'task', index: 5, total: 6 });
  assert.deepEqual(counter('c', task('c-1')), { unit: 'task', index: 6, total: 6 });
});

test('prPerTask counter without a task advances by the group completed-task count', () => {
  const withDone: PrGroup[] = [
    group('a', [task('a-1', true), task('a-2', true)]),
    group('b', [task('b-1', true), task('b-2'), task('b-3')]),
  ];
  const counter = makeStepCounter(withDone, true);
  // group b: 2 tasks before it, 1 done within → next task is global index 4 of 5.
  assert.deepEqual(counter('b'), { unit: 'task', index: 4, total: 5 });
});

test('phaseForStage collapses the stage machine to operator-facing phase words', () => {
  assert.equal(phaseForStage('pending'), 'working');
  assert.equal(phaseForStage('working'), 'working');
  assert.equal(phaseForStage('pr-open'), 'pr-open');
  assert.equal(phaseForStage('waiting-ci'), 'waiting-ci');
  assert.equal(phaseForStage('ci-failed'), 'ci-fix');
  assert.equal(phaseForStage('waiting-reviews'), 'reviewing');
  assert.equal(phaseForStage('addressing-reviews'), 'reviewing');
  assert.equal(phaseForStage('ready-to-merge'), 'merging');
  assert.equal(phaseForStage('merged'), 'merged');
  assert.equal(phaseForStage('blocked'), 'blocked');
});

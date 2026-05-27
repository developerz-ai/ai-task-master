import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrGroup, PrGroupStatus } from '../state/schema.ts';
import { PlanGraph } from './plan-graph.ts';

const group = (id: string, status: PrGroupStatus, dependsOn: string[] = []): PrGroup => ({
  id,
  title: id,
  tasks: [],
  dependsOn,
  branch: null,
  pr: null,
  status,
});

test('PlanGraph is constructible with empty groups', () => {
  const g = new PlanGraph([]);
  assert.ok(g instanceof PlanGraph);
  assert.deepEqual(g.ready(), []);
  assert.deepEqual(g.blocked(), []);
  assert.equal(g.isComplete(), true);
});

test('PlanGraph.ready returns roots when nothing is merged yet', () => {
  const a = group('a', 'pending');
  const b = group('b', 'pending', ['a']);
  const g = new PlanGraph([a, b]);
  assert.deepEqual(
    g.ready().map((x) => x.id),
    ['a'],
  );
});

test('PlanGraph.ready unlocks dependents once deps merge (linear plan)', () => {
  const a = group('a', 'merged');
  const b = group('b', 'pending', ['a']);
  const c = group('c', 'pending', ['b']);
  const g = new PlanGraph([a, b, c]);
  assert.deepEqual(
    g.ready().map((x) => x.id),
    ['b'],
  );
});

test('PlanGraph.ready surfaces parallel siblings with shared dep', () => {
  const root = group('root', 'merged');
  const left = group('left', 'pending', ['root']);
  const right = group('right', 'pending', ['root']);
  const g = new PlanGraph([root, left, right]);
  assert.deepEqual(
    g
      .ready()
      .map((x) => x.id)
      .sort(),
    ['left', 'right'],
  );
});

test('PlanGraph.ready excludes in-progress / awaiting-pr / merged / blocked groups', () => {
  const g = new PlanGraph([
    group('pending', 'pending'),
    group('inprog', 'in-progress'),
    group('await', 'awaiting-pr'),
    group('merged', 'merged'),
    group('blocked', 'blocked'),
  ]);
  assert.deepEqual(
    g.ready().map((x) => x.id),
    ['pending'],
  );
});

test('PlanGraph.blocked lists pending groups with unmerged deps', () => {
  const a = group('a', 'in-progress');
  const b = group('b', 'pending', ['a']);
  const c = group('c', 'pending', ['b']);
  const g = new PlanGraph([a, b, c]);
  assert.deepEqual(
    g
      .blocked()
      .map((x) => x.id)
      .sort(),
    ['b', 'c'],
  );
});

test('PlanGraph.byId returns the group or undefined', () => {
  const a = group('a', 'pending');
  const g = new PlanGraph([a]);
  assert.equal(g.byId('a'), a);
  assert.equal(g.byId('missing'), undefined);
});

test('PlanGraph.isComplete is true only when all groups merged or blocked', () => {
  assert.equal(new PlanGraph([group('a', 'merged'), group('b', 'blocked')]).isComplete(), true);
  assert.equal(new PlanGraph([group('a', 'merged'), group('b', 'pending')]).isComplete(), false);
});

test('PlanGraph.validate throws on dangling dep', () => {
  assert.throws(
    () => PlanGraph.validate([group('a', 'pending', ['ghost'])]),
    /unknown group 'ghost'/,
  );
});

test('PlanGraph.validate throws on direct cycle', () => {
  assert.throws(
    () => PlanGraph.validate([group('a', 'pending', ['b']), group('b', 'pending', ['a'])]),
    /cycle detected/,
  );
});

test('PlanGraph.validate throws on longer cycle', () => {
  assert.throws(
    () =>
      PlanGraph.validate([
        group('a', 'pending', ['c']),
        group('b', 'pending', ['a']),
        group('c', 'pending', ['b']),
      ]),
    /cycle detected/,
  );
});

test('PlanGraph constructor runs validation', () => {
  assert.throws(() => new PlanGraph([group('a', 'pending', ['nope'])]), /unknown group 'nope'/);
});

test('PlanGraph.validate throws on duplicate group id', () => {
  assert.throws(
    () => PlanGraph.validate([group('a', 'pending'), group('a', 'pending')]),
    /duplicate group id 'a'/,
  );
});

test('PlanGraph.validate accepts a valid DAG with diamond shape', () => {
  assert.doesNotThrow(() =>
    PlanGraph.validate([
      group('root', 'pending'),
      group('left', 'pending', ['root']),
      group('right', 'pending', ['root']),
      group('join', 'pending', ['left', 'right']),
    ]),
  );
});

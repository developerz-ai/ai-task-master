import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrGroup, PrGroupStatus } from '../domain/pr-group.ts';
import { PlanGraph } from './plan-graph.ts';

const group = (id: string, status: PrGroupStatus, dependsOn: string[] = []): PrGroup => ({
  id,
  title: id,
  tasks: [],
  dependsOn,
  branch: null,
  pr: null,
  status,
  stage: 'pending',
});

test('PlanGraph is constructible with empty groups', () => {
  const g = PlanGraph.from([]);
  assert.ok(g instanceof PlanGraph);
  assert.deepEqual(g.ready(), []);
  assert.deepEqual(g.blocked(), []);
  assert.equal(g.isComplete(), true);
});

test('PlanGraph.ready returns roots when nothing is merged yet', () => {
  const a = group('a', 'pending');
  const b = group('b', 'pending', ['a']);
  const g = PlanGraph.from([a, b]);
  assert.deepEqual(
    g.ready().map((x) => x.id),
    ['a'],
  );
});

test('PlanGraph.ready unlocks dependents once deps merge (linear plan)', () => {
  const a = group('a', 'merged');
  const b = group('b', 'pending', ['a']);
  const c = group('c', 'pending', ['b']);
  const g = PlanGraph.from([a, b, c]);
  assert.deepEqual(
    g.ready().map((x) => x.id),
    ['b'],
  );
});

test('PlanGraph.ready surfaces parallel siblings with shared dep', () => {
  const root = group('root', 'merged');
  const left = group('left', 'pending', ['root']);
  const right = group('right', 'pending', ['root']);
  const g = PlanGraph.from([root, left, right]);
  assert.deepEqual(
    g
      .ready()
      .map((x) => x.id)
      .sort(),
    ['left', 'right'],
  );
});

test('PlanGraph.ready excludes in-progress / awaiting-pr / merged / blocked groups', () => {
  const g = PlanGraph.from([
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
  const g = PlanGraph.from([a, b, c]);
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
  const g = PlanGraph.from([a]);
  assert.equal(g.byId('a'), a);
  assert.equal(g.byId('missing'), undefined);
});

test('PlanGraph.isComplete is true only when all groups merged or blocked', () => {
  assert.equal(PlanGraph.from([group('a', 'merged'), group('b', 'blocked')]).isComplete(), true);
  assert.equal(PlanGraph.from([group('a', 'merged'), group('b', 'pending')]).isComplete(), false);
});

test('PlanGraph.isComplete: transitively-blocked pending group → terminal (true)', () => {
  // b can never run — its only dep is blocked — so an all-terminal plan is complete, not hung.
  const a = group('a', 'blocked');
  const b = group('b', 'pending', ['a']);
  assert.equal(PlanGraph.from([a, b]).isComplete(), true);
});

test('PlanGraph.isComplete: block propagates down a dependency chain → true', () => {
  const a = group('a', 'blocked');
  const b = group('b', 'pending', ['a']);
  const c = group('c', 'pending', ['b']);
  const g = PlanGraph.from([a, b, c]);
  assert.equal(g.isComplete(), true);
  assert.deepEqual(g.ready(), []); // and nothing downstream is schedulable
});

test('PlanGraph.isComplete: diamond with one blocked leg → true', () => {
  const root = group('root', 'merged');
  const left = group('left', 'blocked');
  const right = group('right', 'merged');
  const join = group('join', 'pending', ['left', 'right']);
  assert.equal(PlanGraph.from([root, left, right, join]).isComplete(), true);
});

test('PlanGraph.isComplete: pending behind an in-progress dep → false', () => {
  // The dep may still merge and unblock b, so the plan is not yet terminal.
  const a = group('a', 'in-progress');
  const b = group('b', 'pending', ['a']);
  assert.equal(PlanGraph.from([a, b]).isComplete(), false);
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

test('PlanGraph.from runs validation', () => {
  assert.throws(() => PlanGraph.from([group('a', 'pending', ['nope'])]), /unknown group 'nope'/);
});

test('PlanGraph.trusted skips validation (assumes prior acceptance-time validate)', () => {
  // A dangling dep makes from()/validate() throw; trusted() builds anyway and just reads live
  // statuses — 'a' stays unready because its missing 'ghost' dep can never merge.
  const g = PlanGraph.trusted([group('a', 'pending', ['ghost'])]);
  assert.deepEqual(g.ready(), []);
  assert.equal(g.isComplete(), false);
});

test('PlanGraph: validate runs once at acceptance, per-tick trusted rebuilds skip it', () => {
  const a = group('a', 'pending');
  const b = group('b', 'pending', ['a']);
  const original = PlanGraph.validate;
  let calls = 0;
  PlanGraph.validate = (groups) => {
    calls += 1;
    original(groups);
  };
  try {
    PlanGraph.validate([a, b]); // acceptance: one structural check for the whole run
    for (let i = 0; i < 5; i++) {
      // each tick rebuilds a graph against live statuses — no re-validation
      PlanGraph.trusted([a, b]).ready();
      PlanGraph.trusted([a, b]).isComplete();
    }
    assert.equal(calls, 1);
  } finally {
    PlanGraph.validate = original;
  }
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

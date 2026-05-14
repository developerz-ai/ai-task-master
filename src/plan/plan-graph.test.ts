import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlanGraph } from './plan-graph.ts';

test('PlanGraph is constructible (skeleton)', () => {
  const g = new PlanGraph([]);
  assert.ok(g instanceof PlanGraph);
});

test('PlanGraph.ready throws until implemented', () => {
  const g = new PlanGraph([]);
  assert.throws(() => g.ready());
});

test('PlanGraph.validate is callable as a static method', () => {
  assert.throws(() => PlanGraph.validate([]));
});

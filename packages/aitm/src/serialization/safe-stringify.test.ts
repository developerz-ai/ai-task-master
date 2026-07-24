import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeStringify } from './safe-stringify.ts';

// Issue #251: same false-cycle family as Logger.redact — a shared reference must serialize
// normally; only a value that is its own ancestor is a cycle.
test('safe-stringify: shared reference (DAG) → serializes normally, not a cycle', () => {
  const shared = { reused: true };
  const dag = { a: shared, b: shared };
  assert.deepEqual(JSON.parse(safeStringify(dag)), { a: { reused: true }, b: { reused: true } });
});

test('safe-stringify: true self-reference cycle → replaced with [CYCLE]', () => {
  const node: Record<string, unknown> = { name: 'root' };
  node.self = node;
  assert.deepEqual(JSON.parse(safeStringify(node)), { name: 'root', self: '[CYCLE]' });
});

test('safe-stringify: sibling cycle two levels deep → only the true ancestor cycle is replaced', () => {
  type Node = { name: string; child?: Node; self?: Node };
  const child: Node = { name: 'child' };
  const root: Node = { name: 'root', child };
  child.self = root;
  assert.deepEqual(JSON.parse(safeStringify(root)), {
    name: 'root',
    child: { name: 'child', self: '[CYCLE]' },
  });
});

test('safe-stringify: no replacer → plain values serialize as JSON.stringify would', () => {
  assert.equal(safeStringify({ a: 1, b: 'two' }), JSON.stringify({ a: 1, b: 'two' }));
});

test('safe-stringify: replacer runs before the cycle check, e.g. converts bigint to string', () => {
  const replacer = (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value;
  assert.equal(safeStringify({ n: 10n }, replacer), '{"n":"10"}');
});

test('safe-stringify: replacer composes with cycle detection on the transformed value', () => {
  const shared = { reused: true };
  const dag = { a: shared, b: shared };
  const replacer = (_key: string, value: unknown) => value;
  assert.deepEqual(JSON.parse(safeStringify(dag, replacer)), {
    a: { reused: true },
    b: { reused: true },
  });
});

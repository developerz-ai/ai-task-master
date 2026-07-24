import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactCopy, redactInPlace } from './redact.ts';

test('redactCopy: leaves the input untouched and returns a redacted copy', () => {
  const input = { apiKey: 'abc', nested: { note: 'Bearer sk-abcdef1234567890' } };
  const out = redactCopy(input) as { apiKey: string; nested: { note: string } };
  assert.equal(input.apiKey, 'abc');
  assert.equal(input.nested.note, 'Bearer sk-abcdef1234567890');
  assert.equal(out.apiKey, '[REDACTED]');
  assert.equal(out.nested.note, 'Bearer [REDACTED]');
});

test('redactInPlace: mutates the object it is given and returns nothing', () => {
  const target = { apiKey: 'abc' };
  assert.equal(redactInPlace(target), undefined);
  assert.equal(target.apiKey, '[REDACTED]');
});

test('redactInPlace: redacts values under secret-shaped keys at any depth', () => {
  const target = {
    a: { b: { authorization: 'Basic dXNlcjpwYXNz', TOKEN: 'plain', harmless: 'kept' } },
  };
  redactInPlace(target);
  assert.deepEqual(target, {
    a: { b: { authorization: '[REDACTED]', TOKEN: '[REDACTED]', harmless: 'kept' } },
  });
});

test('redactInPlace: scrubs secret-shaped strings inside nested arrays', () => {
  const target = { frames: [{ context: ['ok', 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'] }] };
  redactInPlace(target);
  assert.deepEqual(target.frames[0]?.context, ['ok', 'ghp_[REDACTED]']);
});

test('redactInPlace: a cycle terminates and every reachable string is scrubbed once', () => {
  const node: Record<string, unknown> = { url: 'https://user:hunter2@github.com/o/r.git' };
  node.self = node;
  redactInPlace(node);
  assert.equal(node.url, 'https://[REDACTED]github.com/o/r.git');
  assert.equal(node.self, node);
});

test('redactInPlace: a self-referencing array terminates', () => {
  const arr: unknown[] = ['Bearer sk-abcdef1234567890'];
  arr.push(arr);
  redactInPlace(arr);
  assert.equal(arr[0], 'Bearer [REDACTED]');
  assert.equal(arr[1], arr);
});

test('redactInPlace: a shared reference stays intact (not treated as a cycle)', () => {
  const shared = { note: 'Bearer sk-abcdef1234567890' };
  const target = { left: shared, right: shared };
  redactInPlace(target);
  assert.equal(target.left.note, 'Bearer [REDACTED]');
  assert.equal(target.right, shared);
});

test('redactInPlace: primitives and null are no-ops', () => {
  assert.doesNotThrow(() => {
    redactInPlace('Bearer sk-abcdef1234567890');
    redactInPlace(null);
    redactInPlace(undefined);
    redactInPlace(42);
  });
});

test('redactInPlace: preserves non-string leaves', () => {
  const target = { count: 3, ok: false, missing: null, empty: undefined };
  redactInPlace(target);
  assert.deepEqual(target, { count: 3, ok: false, missing: null, empty: undefined });
});

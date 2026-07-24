import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError } from './adapter-support.ts';

// ---- cause preservation (issue #101 slice 04, task 18) --------------------
// Moved here from work-loop.test.ts once work-loop.ts stopped carrying its own duplicate
// definition and started importing this one (task 102: finish the dedup extractions).

test('describeError: an Error is returned as-is — same object, same message, cause untouched', () => {
  const original = new Error('boom', { cause: 'root cause' });
  const described = describeError(original);
  assert.equal(described, original);
  assert.equal(described.message, 'boom');
  assert.equal(described.cause, 'root cause');
});

test('describeError: a non-Error throw is wrapped, same message text, original value as cause', () => {
  const described = describeError('disk full');
  assert.equal(described.message, 'disk full');
  assert.equal(described.cause, 'disk full');
});

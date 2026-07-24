import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capText, MANIFEST_FIELD_MAX, ROLLING_CONTEXT_MAX } from './prompt-caps.ts';

test('capText: text at or under the cap is returned verbatim', () => {
  assert.equal(capText('short', 10), 'short');
  assert.equal(capText('exactly10!', 10), 'exactly10!');
});

test('capText: over-cap text is sliced and marked truncated', () => {
  const text = 'a'.repeat(30);
  const capped = capText(text, 20);
  assert.match(capped, /…truncated\]$/);
  assert.ok(capped.startsWith('a'), 'kept the leading content');
  assert.equal(capped, `${'a'.repeat(7)} […truncated]`);
});

test('capText: a marker-sized-or-smaller max never goes negative — truncates to just the marker', () => {
  const capped = capText('a'.repeat(20), 5);
  assert.equal(capped, ' […truncated]');
});

test('MANIFEST_FIELD_MAX / ROLLING_CONTEXT_MAX: rolling context stays an order of magnitude above a manifest field', () => {
  assert.equal(MANIFEST_FIELD_MAX, 500);
  assert.equal(ROLLING_CONTEXT_MAX, 4000);
  assert.ok(ROLLING_CONTEXT_MAX > MANIFEST_FIELD_MAX);
});

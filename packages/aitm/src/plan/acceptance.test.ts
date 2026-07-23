import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withAcceptanceCheck } from './acceptance.ts';

test('withAcceptanceCheck: appends the check as its own block under a heading', () => {
  const out = withAcceptanceCheck('Do the work.', 'bun test src/auth passes');
  assert.match(out, /^Do the work\.\n\n## Acceptance check for this PR group\n/);
  assert.ok(out.includes('bun test src/auth passes'), 'the check itself is present verbatim');
});

test('withAcceptanceCheck: demands the check be demonstrated, not asserted', () => {
  const out = withAcceptanceCheck('brief', 'the login route returns 200');
  assert.match(out, /never report it as holding on reasoning alone/);
});

test('withAcceptanceCheck: no check leaves the brief byte-identical (legacy plans/state)', () => {
  assert.equal(withAcceptanceCheck('brief', undefined), 'brief');
  assert.equal(withAcceptanceCheck('brief', ''), 'brief');
  assert.equal(withAcceptanceCheck('brief', '   \n  '), 'brief');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chargeCiFixAttempt, routeCiPoll } from './ci-outcome-policy.ts';

// ---- routeCiPoll ---------------------------------------------------------

test('routeCiPoll: green CI → proceed', () => {
  assert.deepEqual(routeCiPoll('success', 7, false), { kind: 'proceed' });
  assert.deepEqual(
    routeCiPoll('success', 7, true),
    { kind: 'proceed' },
    'admin does not change green',
  );
});

test('routeCiPoll: failing CI → fix (admin irrelevant to a real failure)', () => {
  assert.deepEqual(routeCiPoll('failure', 7, false), { kind: 'fix' });
  assert.deepEqual(routeCiPoll('failure', 7, true), { kind: 'fix' });
});

test('routeCiPoll: a leaked pending state routes to fix, not merge (defensive)', () => {
  // pending only comes from an aborted poll, which callers guard before routing; if one leaks it
  // must never read as green.
  assert.deepEqual(routeCiPoll('pending', 7, false), { kind: 'fix' });
});

test('routeCiPoll: timeout without --admin → block, reason names the PR', () => {
  const route = routeCiPoll(null, 42, false);
  assert.equal(route.kind, 'block');
  if (route.kind === 'block') {
    assert.match(route.reason, /PR #42/);
    assert.match(route.reason, /never completed/);
  }
});

test('routeCiPoll: timeout with --admin → advance past CI', () => {
  assert.deepEqual(routeCiPoll(null, 42, true), { kind: 'advance' });
});

// ---- chargeCiFixAttempt --------------------------------------------------

test('chargeCiFixAttempt: below the cap → dispatch, count advances by one', () => {
  assert.deepEqual(chargeCiFixAttempt(0, 3, 7), { kind: 'dispatch', spent: 1 });
  assert.deepEqual(chargeCiFixAttempt(1, 3, 7), { kind: 'dispatch', spent: 2 });
});

test('chargeCiFixAttempt: the cap allows N fixes, not N − 1 (boundary)', () => {
  // spent 2 with cap 3 is the third and last allowed fix.
  assert.deepEqual(chargeCiFixAttempt(2, 3, 7), { kind: 'dispatch', spent: 3 });
});

test('chargeCiFixAttempt: charging past the cap → exhausted, reason names cap + PR', () => {
  const charge = chargeCiFixAttempt(3, 3, 7);
  assert.equal(charge.kind, 'exhausted');
  assert.equal(charge.spent, 4, 'the count advances to the blocking entry (cap + 1)');
  if (charge.kind === 'exhausted') {
    assert.match(charge.reason, /exhausted after 3 passes/);
    assert.match(charge.reason, /PR #7/);
    assert.match(charge.reason, /needs human attention/);
  }
});

test('chargeCiFixAttempt: a cap of zero exhausts on the first charge', () => {
  assert.deepEqual(chargeCiFixAttempt(0, 0, 5), {
    kind: 'exhausted',
    spent: 1,
    reason: 'CI fix attempts exhausted after 0 passes for PR #5 — needs human attention',
  });
});

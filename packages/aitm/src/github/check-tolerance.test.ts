// Regression: a rate-limited CodeRabbit status ("CodeRabbit" / fail / "Review rate limited") turned
// the whole check set red, so the loop ran a CI fix session and then spun on a check no commit can
// turn green. Only that exact check/message pair is tolerated.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isToleratedFailure, TOLERATED_FAILURES_ENV, toleratedReason } from './check-tolerance.ts';
import { GitHubClient, type RunCmd, type Sleep } from './github-client.ts';

// Local stand-ins for the shim helpers in github-client.test.ts: one canned `gh` reply per call,
// and a sleep that records instead of waiting.
function makeRun(replies: Array<{ stdout?: string; exitCode?: number }>): {
  run: RunCmd;
  calls: Array<{ file: string; args: string[] }>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: RunCmd = async (file, args) => {
    calls.push({ file, args: [...args] });
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error(`No mocked reply for call #${calls.length - 1}`);
    return { stdout: reply.stdout ?? '', stderr: '', exitCode: reply.exitCode ?? 0 };
  };
  return { run, calls };
}

function makeSleep(): { sleep: Sleep; delays: number[] } {
  const delays: number[] = [];
  const sleep: Sleep = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

const RATE_LIMITED = { name: 'CodeRabbit', description: 'Review rate limited' };

test('CodeRabbit rate limiting is tolerated', () => {
  assert.equal(isToleratedFailure(RATE_LIMITED), true);
  assert.match(toleratedReason(RATE_LIMITED) ?? '', /quota/);
});

test('matching ignores case and surrounding whitespace', () => {
  assert.equal(
    isToleratedFailure({ name: '  coderabbit ', description: ' REVIEW RATE LIMITED ' }),
    true,
  );
});

// Regression: only the exact 'Review rate limited' string matched, so CodeRabbit's sibling
// 'Review limit reached' wording still failed CI.
test('every CodeRabbit quota wording is tolerated', () => {
  for (const description of [
    'Review rate limited',
    'Review limit reached',
    'You have reached your review rate limit',
  ]) {
    assert.equal(isToleratedFailure({ name: 'CodeRabbit', description }), true, description);
  }
});

test('a real CodeRabbit verdict is still a failure', () => {
  for (const description of ['Review failed', '1 issue found', '3 issues found', '']) {
    assert.equal(isToleratedFailure({ name: 'CodeRabbit', description }), false, description);
  }
  assert.equal(isToleratedFailure({ name: 'CodeRabbit' }), false);
});

// Loose matching is opt-in per rule: an env-declared rule stays exact, so a typo there cannot
// silently swallow a whole family of failures.
test('environment rules stay exact', () => {
  const previous = process.env[TOLERATED_FAILURES_ENV];
  process.env[TOLERATED_FAILURES_ENV] = 'bot=limit';
  try {
    assert.equal(isToleratedFailure({ name: 'bot', description: 'limit' }), true);
    assert.equal(isToleratedFailure({ name: 'bot', description: 'limit reached' }), false);
  } finally {
    if (previous === undefined) delete process.env[TOLERATED_FAILURES_ENV];
    else process.env[TOLERATED_FAILURES_ENV] = previous;
  }
});

test('the same message from another check is a real failure', () => {
  assert.equal(isToleratedFailure({ name: 'OtherBot', description: 'Review rate limited' }), false);
});

test('extra rules can be declared via the environment', () => {
  const previous = process.env[TOLERATED_FAILURES_ENV];
  process.env[TOLERATED_FAILURES_ENV] = 'some-bot=quota exceeded; other=busy';
  try {
    assert.equal(isToleratedFailure({ name: 'some-bot', description: 'Quota exceeded' }), true);
    assert.equal(isToleratedFailure({ name: 'other', description: 'busy' }), true);
    assert.equal(isToleratedFailure({ name: 'some-bot', description: 'broken' }), false);
  } finally {
    if (previous === undefined) delete process.env[TOLERATED_FAILURES_ENV];
    else process.env[TOLERATED_FAILURES_ENV] = previous;
  }
});

test('malformed environment rules are skipped, not thrown', () => {
  const previous = process.env[TOLERATED_FAILURES_ENV];
  process.env[TOLERATED_FAILURES_ENV] = 'garbage;;=x;y=';
  try {
    assert.equal(isToleratedFailure(RATE_LIMITED), true);
  } finally {
    if (previous === undefined) delete process.env[TOLERATED_FAILURES_ENV];
    else process.env[TOLERATED_FAILURES_ENV] = previous;
  }
});

test('waitForChecks: a rate-limited review bot alone does not fail CI', async () => {
  const { run } = makeRun([
    {
      stdout: JSON.stringify([
        { bucket: 'pass', name: 'test', state: 'SUCCESS', description: '' },
        {
          bucket: 'fail',
          name: 'CodeRabbit',
          state: 'FAILURE',
          description: 'Review rate limited',
        },
      ]),
    },
  ]);
  const { sleep } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);

  assert.deepEqual(await g.waitForChecks(42), { state: 'success', failedChecks: [] });
});

test('waitForChecks: a real failure alongside the rate limit still fails', async () => {
  const { run } = makeRun([
    {
      stdout: JSON.stringify([
        { bucket: 'fail', name: 'test', state: 'FAILURE', description: '' },
        {
          bucket: 'fail',
          name: 'CodeRabbit',
          state: 'FAILURE',
          description: 'Review rate limited',
        },
      ]),
    },
  ]);
  const { sleep } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);

  assert.deepEqual(await g.waitForChecks(42), {
    state: 'failure',
    failedChecks: [{ name: 'test', status: 'failure' }],
  });
});

test('waitForChecks: rate limit with checks still running stays pending', async () => {
  const pendingRows = JSON.stringify([
    { bucket: 'pending', name: 'test', state: 'IN_PROGRESS', description: '' },
    { bucket: 'fail', name: 'CodeRabbit', state: 'FAILURE', description: 'Review rate limited' },
  ]);
  const passingRows = JSON.stringify([
    { bucket: 'pass', name: 'test', state: 'SUCCESS', description: '' },
    { bucket: 'fail', name: 'CodeRabbit', state: 'FAILURE', description: 'Review rate limited' },
  ]);
  const { run, calls } = makeRun([{ stdout: pendingRows }, { stdout: passingRows }]);
  const { sleep } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);

  assert.deepEqual(await g.waitForChecks(42), { state: 'success', failedChecks: [] });
  assert.equal(calls.length, 2, 'kept polling instead of resolving off the tolerated failure');
});

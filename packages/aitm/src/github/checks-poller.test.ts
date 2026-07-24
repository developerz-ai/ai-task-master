import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHECKS_EMPTY_GRACE_MS,
  CHECKS_INITIAL_DELAY_MS,
  CHECKS_MAX_CONSECUTIVE_FAILURES,
  CHECKS_MAX_DELAY_MS,
  CHECKS_START_WAIT_MS,
  CHECKS_TIMEOUT_MS,
  pollChecks,
} from './checks-poller.ts';
import { CiFailed } from './errors.ts';
import {
  DEFAULT_CMD_TIMEOUT_MS,
  type RunCmd,
  type RunCmdResult,
  type Sleep,
} from './github-client.ts';

// Local stand-ins for the shim helpers in github-client.test.ts — pollChecks takes a plain RunCmd/
// Sleep, no GitHubClient involved, so these only need to fake the `gh pr checks` transport.
type Reply = Partial<RunCmdResult> & { exitCode?: number };

function makeRun(replies: Reply[] | ((idx: number) => Reply)): {
  run: RunCmd;
  calls: Array<{ file: string; args: string[] }>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: RunCmd = async (file, args) => {
    calls.push({ file, args: [...args] });
    const idx = calls.length - 1;
    const reply = typeof replies === 'function' ? replies(idx) : replies[idx];
    if (!reply) {
      throw new Error(`No mocked reply for call #${idx}: ${file} ${args.join(' ')}`);
    }
    return {
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode ?? 0,
    };
  };
  return { run, calls };
}

function makeSleep(onSleep?: (ms: number) => void): {
  sleep: Sleep;
  delays: number[];
  signals: Array<AbortSignal | undefined>;
} {
  const delays: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const sleep: Sleep = async (ms, signal) => {
    delays.push(ms);
    signals.push(signal);
    onSleep?.(ms);
  };
  return { sleep, delays, signals };
}

// A sleep whose delays also advance a fake wall clock, paired with the `now` to inject as
// pollChecks' clock — so the Date.now-anchored timeout budget is reachable in tests without real
// time. `advance` models non-sleep wall-time (e.g. a slow subprocess) crossing the budget.
function makeClock(): {
  sleep: Sleep;
  now: () => number;
  delays: number[];
  advance: (ms: number) => void;
} {
  let clock = 0;
  const delays: number[] = [];
  const advance = (ms: number): void => {
    clock += ms;
  };
  const sleep: Sleep = async (ms) => {
    delays.push(ms);
    advance(ms);
  };
  return { sleep, now: () => clock, delays, advance };
}

test('pollChecks returns success when all checks pass', async () => {
  const { run, calls } = makeRun([
    {
      stdout: JSON.stringify([
        { bucket: 'pass', name: 'lint', state: 'SUCCESS' },
        { bucket: 'pass', name: 'test', state: 'SUCCESS' },
        { bucket: 'skipping', name: 'release', state: 'NEUTRAL' },
      ]),
    },
  ]);
  const { sleep, delays } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 42, sleep);
  assert.equal(result.state, 'success');
  assert.deepEqual(result.failedChecks, []);
  assert.deepEqual(calls[0]?.args, [
    'pr',
    'checks',
    '42',
    '--json',
    'bucket,name,state,description',
  ]);
  // Only the start-wait before the first poll; a green first poll adds no backoff sleeps.
  assert.deepEqual(delays, [CHECKS_START_WAIT_MS]);
});

test('pollChecks: empty checks read as pending, not instant success', async () => {
  // A just-pushed PR whose Actions haven't registered returns []. It must keep polling (pending)
  // and let the real checks decide — never insta-succeed and merge before CI runs.
  const empty = '[]';
  const passing = JSON.stringify([{ bucket: 'pass', name: 'test', state: 'SUCCESS' }]);
  const { run, calls } = makeRun([{ stdout: empty }, { stdout: empty }, { stdout: passing }]);
  const { sleep, delays } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 5, sleep);
  assert.equal(result.state, 'success');
  assert.deepEqual(result.failedChecks, []);
  assert.equal(calls.length, 3);
  assert.equal(delays[0], CHECKS_START_WAIT_MS);
});

test('pollChecks: a PR with no checks resolves to success only after the empty grace', async () => {
  const { run, calls } = makeRun(() => ({ stdout: '[]' }));
  const { sleep, delays } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 1, sleep);
  assert.equal(result.state, 'success');
  assert.deepEqual(result.failedChecks, []);
  assert.ok(calls.length > 1, 'did not insta-succeed on the first empty poll');
  const emptyPollWait = delays.slice(1).reduce((sum, d) => sum + d, 0);
  assert.ok(
    emptyPollWait >= CHECKS_EMPTY_GRACE_MS,
    'waited the full empty grace before concluding the PR has no checks',
  );
});

test('CHECKS_START_WAIT_MS / CHECKS_EMPTY_GRACE_MS: 60s each', () => {
  assert.equal(CHECKS_START_WAIT_MS, 60_000);
  assert.equal(CHECKS_EMPTY_GRACE_MS, 60_000);
});

test('pollChecks polls while pending with 1s→2s→4s backoff (60s cap)', async () => {
  const pending = JSON.stringify([{ bucket: 'pending', name: 'test', state: 'IN_PROGRESS' }]);
  const passing = JSON.stringify([{ bucket: 'pass', name: 'test', state: 'SUCCESS' }]);
  const { run, calls } = makeRun([
    { stdout: pending },
    { stdout: pending },
    { stdout: pending },
    { stdout: passing },
  ]);
  const { sleep, delays } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 7, sleep);
  assert.equal(result.state, 'success');
  assert.equal(calls.length, 4);
  assert.deepEqual(delays, [CHECKS_START_WAIT_MS, 1000, 2000, 4000]);
});

test('pollChecks caps backoff at CHECKS_MAX_DELAY_MS', async () => {
  // 7 pending replies before success → delays: 1, 2, 4, 8, 16, 32, 60 (capped).
  const pending = JSON.stringify([{ bucket: 'pending', name: 'slow', state: 'QUEUED' }]);
  const passing = JSON.stringify([{ bucket: 'pass', name: 'slow', state: 'SUCCESS' }]);
  const replies: Reply[] = Array.from({ length: 7 }, () => ({ stdout: pending }));
  replies.push({ stdout: passing });
  const { run } = makeRun(replies);
  const { sleep, delays } = makeSleep();
  await pollChecks(run, '/tmp/repo', 1, sleep);
  assert.deepEqual(delays, [
    CHECKS_START_WAIT_MS,
    1000,
    2000,
    4000,
    8000,
    16_000,
    32_000,
    CHECKS_MAX_DELAY_MS,
  ]);
  assert.equal(CHECKS_INITIAL_DELAY_MS, 1000);
});

test('pollChecks returns a failure CiResult (not a throw) for a failed bucket', async () => {
  const { run } = makeRun([
    {
      stdout: JSON.stringify([
        { bucket: 'pass', name: 'lint', state: 'SUCCESS' },
        { bucket: 'fail', name: 'test', state: 'FAILURE' },
      ]),
      exitCode: 8,
    },
  ]);
  const { sleep, delays } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 99, sleep);
  assert.equal(result.state, 'failure');
  assert.deepEqual(result.failedChecks, [{ name: 'test', status: 'failure' }]);
  assert.deepEqual(
    result.checks,
    [
      { name: 'lint', bucket: 'pass' },
      { name: 'test', bucket: 'fail' },
    ],
    'every settled check is summarised, not just the failed one',
  );
  // Start-wait only; a decisive first poll adds no backoff sleeps.
  assert.deepEqual(delays, [CHECKS_START_WAIT_MS]);
});

test('pollChecks reports a cancelled bucket as a failure CiResult', async () => {
  const { run } = makeRun([
    { stdout: JSON.stringify([{ bucket: 'cancel', name: 'test', state: 'CANCELLED' }]) },
  ]);
  const { sleep } = makeSleep();
  const cancelledResult = await pollChecks(run, '/tmp/repo', 99, sleep);
  assert.equal(cancelledResult.state, 'failure');
  assert.deepEqual(cancelledResult.failedChecks, [{ name: 'test', status: 'cancelled' }]);
});

test('pollChecks throws CiFailed once the poll timeout budget is exhausted', async () => {
  // Only-pending replies: the injected wall clock advances through the start grace and each backoff
  // until it crosses CHECKS_TIMEOUT_MS and the poll gives up. CiFailed is reserved strictly for this.
  const pending = JSON.stringify([{ bucket: 'pending', name: 'test', state: 'IN_PROGRESS' }]);
  const { run } = makeRun(() => ({ stdout: pending }));
  const { sleep, now, delays } = makeClock();
  await assert.rejects(() => pollChecks(run, '/tmp/repo', 1, sleep, now), CiFailed);
  assert.ok(
    delays.reduce((sum, d) => sum + d, 0) >= CHECKS_TIMEOUT_MS,
    'gave up only after the timeout budget was spent',
  );
});

test('pollChecks: an already-aborted signal → pending, no gh call at all', async () => {
  const { run, calls } = makeRun(() => ({ stdout: '[]' }));
  const { sleep, signals } = makeSleep();
  const controller = new AbortController();
  controller.abort();
  const result = await pollChecks(run, '/tmp/repo', 1, sleep, undefined, controller.signal);
  // Not a verdict — the poll never settled. Callers re-check the signal rather than reading this
  // as "CI is still running".
  assert.equal(result.state, 'pending');
  assert.deepEqual(result.checks, []);
  assert.equal(calls.length, 0, 'a cancelled wait spawns no `gh pr checks`');
  assert.equal(signals[0], controller.signal, 'the start grace is cancellable');
});

test('pollChecks: abort mid-poll → stops after the in-flight poll, never times out', async () => {
  // Only-pending replies: without the abort this run would poll for the full 120-minute budget and
  // end in CiFailed. The abort lands during the first backoff, so exactly one more poll happens.
  const pending = JSON.stringify([{ bucket: 'pending', name: 'test', state: 'IN_PROGRESS' }]);
  const { run, calls } = makeRun(() => ({ stdout: pending }));
  const controller = new AbortController();
  const { sleep, signals } = makeSleep((ms) => {
    if (ms === CHECKS_INITIAL_DELAY_MS) controller.abort();
  });
  const result = await pollChecks(run, '/tmp/repo', 1, sleep, undefined, controller.signal);
  assert.equal(result.state, 'pending');
  assert.deepEqual(result.failedChecks, []);
  assert.equal(calls.length, 1, 'the poll loop stops at the top of the next iteration');
  assert.deepEqual(
    signals,
    [controller.signal, controller.signal],
    'both the start grace and the backoff take the signal',
  );
});

test('pollChecks: aborted during the gh call → pending, not a parse failure', async () => {
  const controller = new AbortController();
  const run: RunCmd = async () => {
    controller.abort();
    return { stdout: '', stderr: '', exitCode: 1 };
  };
  const { sleep } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 1, sleep, undefined, controller.signal);
  assert.equal(result.state, 'pending');
  assert.deepEqual(result.checks, []);
});

test('pollChecks: a transient unparseable read is tolerated, not fatal', async () => {
  // One bad read — a truncated stdout, a network blip — must not abandon a wait that can run for the
  // full 120-minute budget. Poll through it and let the next good read settle the verdict.
  const passing = JSON.stringify([{ bucket: 'pass', name: 'test', state: 'SUCCESS' }]);
  const { run, calls } = makeRun([
    { exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com' },
    { stdout: passing },
  ]);
  const { sleep } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 1, sleep);
  assert.equal(result.state, 'success');
  assert.equal(calls.length, 2, 'retried the failed read instead of throwing on it');
});

test('pollChecks: throws GhCommandFailed after N consecutive failed reads', async () => {
  // A persistent break (garbage every poll: an auth revocation, a wedged network) surfaces once the
  // consecutive-failure budget is spent — not silently waved through as a mergeable "no checks".
  const { run, calls } = makeRun(() => ({
    exitCode: 1,
    stdout: '',
    stderr: 'error connecting to api.github.com',
  }));
  const { sleep } = makeSleep();
  await assert.rejects(() => pollChecks(run, '/tmp/repo', 1, sleep), /gh pr checks failed/);
  assert.equal(
    calls.length,
    CHECKS_MAX_CONSECUTIVE_FAILURES,
    'gave up only after N consecutive failures',
  );
});

test('pollChecks: a good read resets the consecutive-failure count', async () => {
  // N-1 failures, one pending success, then N-1 more failures must NOT throw — the good poll resets
  // the run, so neither burst on its own reaches the threshold.
  const fail: Reply = { exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com' };
  const pending: Reply = {
    stdout: JSON.stringify([{ bucket: 'pending', name: 'test', state: 'QUEUED' }]),
  };
  const passing: Reply = {
    stdout: JSON.stringify([{ bucket: 'pass', name: 'test', state: 'SUCCESS' }]),
  };
  const replies: Reply[] = [];
  for (let i = 0; i < CHECKS_MAX_CONSECUTIVE_FAILURES - 1; i++) replies.push({ ...fail });
  replies.push(pending);
  for (let i = 0; i < CHECKS_MAX_CONSECUTIVE_FAILURES - 1; i++) replies.push({ ...fail });
  replies.push(passing);
  const { run } = makeRun(replies);
  const { sleep } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 1, sleep);
  assert.equal(result.state, 'success');
});

test('pollChecks: a checkless PR (gh "no checks reported") resolves to success after the grace', async () => {
  // gh exits non-zero with an empty stdout and "no checks reported on the '<branch>' branch" on
  // stderr for a PR with no checks configured. That is an empty row set, not a failure: it must
  // wait out the empty grace and then be mergeable — never throw, never insta-succeed.
  const { run, calls } = makeRun(() => ({
    exitCode: 1,
    stdout: '',
    stderr: "no checks reported on the 'feature/x' branch",
  }));
  const { sleep, delays } = makeSleep();
  const result = await pollChecks(run, '/tmp/repo', 3, sleep);
  assert.equal(result.state, 'success');
  assert.deepEqual(result.checks, []);
  assert.ok(calls.length > 1, 'did not insta-succeed on the first empty read');
  const emptyPollWait = delays.slice(1).reduce((sum, d) => sum + d, 0);
  assert.ok(
    emptyPollWait >= CHECKS_EMPTY_GRACE_MS,
    'waited the full empty grace before deeming the PR checkless',
  );
});

test('pollChecks: the timeout budget counts the start grace and subprocess wall-time, not just backoff', async () => {
  // Model each `gh pr checks` as a near-deadline (5-min) subprocess by advancing the clock inside the
  // run stub. Anchored on the wall clock, that subprocess time (plus the 60s start grace) crosses
  // CHECKS_TIMEOUT_MS even though the accumulated backoff alone never would — the exact accounting
  // gap (`waited += delay`) this guards against.
  const pending = JSON.stringify([{ bucket: 'pending', name: 'test', state: 'IN_PROGRESS' }]);
  const { sleep, now, delays, advance } = makeClock();
  const run: RunCmd = async () => {
    advance(DEFAULT_CMD_TIMEOUT_MS);
    return { stdout: pending, stderr: '', exitCode: 0 };
  };
  await assert.rejects(() => pollChecks(run, '/tmp/repo', 1, sleep, now), CiFailed);
  const backoffOnly = delays.slice(1).reduce((sum, d) => sum + d, 0);
  assert.ok(
    backoffOnly < CHECKS_TIMEOUT_MS,
    'backoff sleeps alone never reached the budget — subprocess and start-grace time did',
  );
});

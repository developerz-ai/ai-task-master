// REAL-spawn tests for the sandbox test runner (#308): a bare temp checkout (no package.json, no
// node_modules — exactly the benchmark fixture shape) holding a produced module + produced test,
// executed through the same harness command the runner would use. No mocks, no services: the point
// is that spawn/kill/capture works against real child processes on this machine, on the repo's own
// runners (`node --test --import tsx`).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandboxTestRunner } from './scenario-exec.ts';

const GOOD_MOD =
  'export function slugify(input: string): string {\n' +
  "  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" +
  '}\n';

const PASSING_TEST =
  "import assert from 'node:assert/strict';\n" +
  "import { test } from 'node:test';\n" +
  "import { slugify } from './slugify.ts';\n" +
  "test('slugify', () => {\n" +
  "  assert.equal(slugify('A B'), 'a-b');\n" +
  "  assert.equal(slugify('--Hi There!--'), 'hi-there');\n" +
  '});\n';

// A well-formed test whose ASSERTION is wrong: it must execute and FAIL, which is exactly the
// "static checks alone cannot catch" case the executor exists for.
const WRONG_EXPECTATION_TEST =
  "import assert from 'node:assert/strict';\n" +
  "import { test } from 'node:test';\n" +
  "import { slugify } from './slugify.ts';\n" +
  "test('slugify', () => {\n" +
  "  assert.equal(slugify('A B'), 'totally-wrong');\n" +
  '});\n';

// Hung FOREVER: no self-exit, no rescue timer — only the budget kill can end it, so any process
// the kill misses leaks, and the timeout test below catches exactly that by watching `ps`.
const HANGING_TEST =
  "import { test } from 'node:test';\n" +
  "test('hangs forever', async () => {\n" +
  '  await new Promise(() => {});\n' +
  '});\n';

// A bare checkout: the fixture files ONLY — no package.json, no node_modules — so the executor's
// resolved-from-this-checkout tooling is what makes the run possible, like in the real sandbox.
async function makeCheckout(testBody: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-scenario-exec-'));
  await writeFile(join(dir, 'slugify.ts'), GOOD_MOD);
  await writeFile(join(dir, 'slugify.test.ts'), testBody);
  return dir;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// POSIX only: pids of live processes whose command line still names the produced test file. After
// the budget kill NOTHING may remain — `node --test` executes the produced file in a child of the
// spawned wrapper, so a kill that reaches only the wrapper strands that child (reparented, hung
// forever) while the runner itself reports a tidy timeout.
function survivorPids(): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const ps = spawn('ps', ['-eo', 'pid=,args=']);
    let out = '';
    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    ps.once('error', reject);
    ps.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ps exited with ${code}`));
        return;
      }
      resolve(
        out
          .split('\n')
          .filter((line) => line.includes('slugify.test.ts'))
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isInteger(pid)),
      );
    });
  });
}

// Reap anything the budget kill missed so a red run cannot leak a forever-hung process onto the
// machine; callers assert on the list they passed in.
function killSurvivors(pids: number[]): void {
  for (const pid of pids) process.kill(pid, 'SIGKILL');
}

test('scenario-exec: a correct produced test executes green (exit 0, output captured)', {
  timeout: 30_000,
}, async () => {
  const dir = await makeCheckout(PASSING_TEST);
  try {
    const result = await makeSandboxTestRunner(dir)('slugify.test.ts', 30_000);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.error, undefined, 'no error when the command ran');
    assert.ok(result.stdout.length > 0, 'runner output is captured');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scenario-exec: a wrong expectation exits non-zero with captured failure output', {
  timeout: 30_000,
}, async () => {
  const dir = await makeCheckout(WRONG_EXPECTATION_TEST);
  try {
    const result = await makeSandboxTestRunner(dir)('slugify.test.ts', 30_000);
    assert.equal(result.timedOut, false);
    assert.ok(result.exitCode !== null, 'a completed run has a numeric exit code');
    assert.notEqual(result.exitCode, 0, 'the failing test must not exit 0');
    assert.ok(
      (result.stdout + result.stderr).length > 0,
      'the failure output (assertion error) is captured',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scenario-exec: a hung test is SIGKILLed at the budget (timedOut, exitCode null)', {
  timeout: 30_000,
}, async () => {
  const dir = await makeCheckout(HANGING_TEST);
  try {
    // The fixture never returns on its own, so a broken kill path would hang the runner (and leak
    // its wrapper) forever: cap the wait, reap what leaked, and fail loudly instead.
    let bailTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      makeSandboxTestRunner(dir)('slugify.test.ts', 500),
      new Promise<null>((resolve) => {
        bailTimer = setTimeout(() => resolve(null), 10_000);
      }),
    ]);
    clearTimeout(bailTimer);
    if (result === null) {
      killSurvivors(await survivorPids());
      assert.fail('the runner never returned from a hung test — the budget kill is broken');
    }
    assert.equal(result.timedOut, true, 'the budget marks the run as timed out');
    assert.equal(result.exitCode, null, 'a killed run has no exit code');
    if (process.platform !== 'win32') {
      // A tidy timeout REPORT is not the contract — nothing may SURVIVE it. Watch ~3s: on node the
      // produced test runs as a child of the killed wrapper, and only a kill that reached the whole
      // process tree keeps that child from being reparented and hung forever.
      let survivors: number[] = [];
      for (let i = 0; i < 10 && survivors.length === 0; i++) {
        await delay(300);
        survivors = await survivorPids();
      }
      killSurvivors(survivors);
      assert.deepEqual(
        survivors,
        [],
        'no produced-test process may survive the budget kill (killing the wrapper alone strands its child)',
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scenario-exec: the runner never rejects, even across repeated calls', {
  timeout: 30_000,
}, async () => {
  const dir = await makeCheckout(PASSING_TEST);
  try {
    const run = makeSandboxTestRunner(dir);
    const first = await run('slugify.test.ts', 30_000);
    const second = await run('slugify.test.ts', 30_000);
    assert.equal(first.exitCode, 0);
    assert.equal(second.exitCode, 0, 'the executor is reusable');
    // A path that does not exist must come back as a resolved RESULT (never a thrown error) that
    // cannot be mistaken for a pass.
    const missing = await run('nope.test.ts', 30_000);
    assert.ok(
      missing.exitCode === null || missing.exitCode !== 0,
      'a missing produced test can never read as a pass',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

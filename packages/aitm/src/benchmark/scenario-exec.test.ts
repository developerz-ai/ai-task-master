// REAL-spawn tests for the sandbox test runner (#308): a bare temp checkout (no package.json, no
// node_modules — exactly the benchmark fixture shape) holding a produced module + produced test,
// executed through the same harness command the runner would use. No mocks, no services: the point
// is that spawn/kill/capture works against real child processes on this machine, on the repo's own
// runners (`node --test --import tsx`).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { killProcessTree, makeSandboxTestRunner } from './scenario-exec.ts';
import { scenarioById } from './scenarios.ts';

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
// the kill misses leaks, and the timeout test below catches exactly that by watching the process
// table. The pending promise alone does NOT hang: an unresolved promise keeps nothing alive, so on
// node 20 and 22 the produced file's event loop drains and the process EXITS on its own ("Promise
// resolution is still pending but the event loop has already resolved") — the run then ends before
// the budget, which is not a timeout at all. The live interval is what holds the loop open on every
// runtime, so the budget kill really is the only way out.
const HANGING_TEST =
  "import { test } from 'node:test';\n" +
  "test('hangs forever', async () => {\n" +
  '  await new Promise(() => {\n' +
  '    setInterval(() => {}, 1000);\n' +
  '  });\n' +
  '});\n';

// A bare checkout: the fixture files ONLY — no package.json, no node_modules — so the executor's
// resolved-from-this-checkout tooling is what makes the run possible, like in the real sandbox.
async function makeCheckout(testBody: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-scenario-exec-'));
  await writeFile(join(dir, 'slugify.ts'), GOOD_MOD);
  await writeFile(join(dir, 'slugify.test.ts'), testBody);
  return dir;
}

// The grade-2 scenario's own fixture shape — src/slugify.ts + src/slugify.test.ts inside the
// checkout — so the REAL runner's output can be fed to the REAL verifier.
async function makeScenarioCheckout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-scenario-exec-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'slugify.ts'), GOOD_MOD);
  await writeFile(join(dir, 'src', 'slugify.test.ts'), PASSING_TEST);
  return dir;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The pids of live processes whose command line names THIS fixture's absolute test path. The path
// is unique per fixture (mkdtemp), so the scan can never reach another run's processes: a
// machine-wide 'slugify.test.ts' substring matched every CONCURRENT fixture's worker, and the
// cleanup below then SIGKILLed a process that had nothing to do with this test.
//
// POSIX only: `node --test` executes the produced file in a child of the spawned wrapper, so a kill
// that reaches only the wrapper strands that child (reparented, hung forever) while the runner
// itself reports a tidy timeout.
function survivorPids(absTestPath: string): Promise<number[]> {
  if (process.platform === 'win32') return windowsSurvivorPids(absTestPath);
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
          .filter((line) => line.includes(absTestPath))
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isInteger(pid)),
      );
    });
  });
}

// Windows: the process table with command lines comes from CIM (wmic is gone from recent Windows).
function windowsSurvivorPids(absTestPath: string): Promise<number[]> {
  const needle = absTestPath.replace(/'/g, "''");
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ` +
    `$_.CommandLine.Contains('${needle}') } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    let out = '';
    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    ps.once('error', reject);
    ps.once('close', () => {
      resolve(
        out
          .split('\n')
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isInteger(pid)),
      );
    });
  });
}

// Reap anything the budget kill missed so a red run cannot leak a forever-hung process onto the
// machine. The list comes from the fixture-scoped scan above, so this can only ever touch THIS
// fixture's processes.
function killSurvivors(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
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
  timeout: 60_000,
}, async () => {
  const dir = await makeCheckout(HANGING_TEST);
  const absTestPath = join(dir, 'slugify.test.ts');
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
      killSurvivors(await survivorPids(absTestPath));
      assert.fail('the runner never returned from a hung test — the budget kill is broken');
    }
    assert.equal(result.timedOut, true, 'the budget marks the run as timed out');
    assert.equal(result.exitCode, null, 'a killed run has no exit code');
    // A tidy timeout REPORT is not the contract — nothing may SURVIVE it. Watch a few seconds: on
    // node the produced test runs as a child of the killed wrapper, and only a kill that reached the
    // whole process tree keeps that child from being reparented and hung forever. On Windows the
    // same holds for `node --test`'s worker, which taskkill /T reaches and a wrapper-only kill
    // would strand.
    let survivors: number[] = [];
    for (let i = 0; i < 6 && survivors.length === 0; i++) {
      await delay(300);
      survivors = await survivorPids(absTestPath);
    }
    killSurvivors(survivors);
    assert.deepEqual(
      survivors,
      [],
      'no produced-test process may survive the budget kill (killing the wrapper alone strands its child)',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scenario-exec: the Windows budget kill takes the whole tree down (taskkill /T /F)', {
  // On a real Windows host the hang test above drives the REAL taskkill; the fake here pins the
  // COMMAND on the platform CI runs on (Linux), where a wrapper-only kill would be invisible.
  skip: process.platform === 'win32' ? 'the real taskkill is exercised by the hang test' : false,
  timeout: 30_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-taskkill-'));
  const binDir = join(dir, 'bin');
  const argsFile = join(dir, 'taskkill-args.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, 'taskkill'),
    `#!/bin/sh\nprintf '%s' "$*" > '${argsFile}'\nexit 0\n`,
  );
  await chmod(join(binDir, 'taskkill'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${savedPath ?? ''}`;
  try {
    await killProcessTree(4242, 'win32');
    const recorded = await readFile(argsFile, 'utf8');
    assert.equal(
      recorded,
      '/pid 4242 /T /F',
      'the Windows kill must take the tree down (taskkill /T), not just the wrapper',
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
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

// The regression this pins (#368): the verdict must read the runner's ACTUAL summary. node:test's
// TAP reporter prints `# pass 2` to stdout, its spec reporter (the default since node 22) prints
// `ℹ pass 2`, and bun prints ` 2 pass` — on STDERR. A parser that read stdout only (or matched
// 'passed' only) scored a successful grade-2 run as a failure.
test('scenario-exec: the real runner output drives the real verifier to a pass (#368)', {
  timeout: 60_000,
}, async () => {
  const dir = await makeScenarioCheckout();
  try {
    const exec = await makeSandboxTestRunner(dir)('src/slugify.test.ts', 30_000);
    assert.equal(exec.error, undefined, `the produced test ran: ${exec.error ?? 'no error'}`);
    assert.equal(exec.exitCode, 0, 'the produced test passed');
    const scenario = scenarioById('multi-file-feature');
    assert.ok(scenario);
    const result = await scenario.verify({
      slug: 'acme/sandbox',
      defaultBranch: 'main',
      readFile: async (path) => {
        if (path === 'src/slugify.ts') return GOOD_MOD;
        if (path === 'src/slugify.test.ts') return PASSING_TEST;
        return null;
      },
      runTest: async () => exec,
    });
    assert.equal(
      result.ok,
      true,
      `the verdict must follow the runner's own summary: ${result.detail}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

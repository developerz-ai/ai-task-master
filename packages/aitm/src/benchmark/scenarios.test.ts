// Pure tests for the benchmark scenario registry (issue #184): lookup, registry invariants, and each
// scenario's verify() predicate driven by a mock file reader (no sandbox needed).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BENCH_SCENARIOS,
  type ScenarioExecResult,
  type ScenarioVerify,
  scenarioById,
  TEST_EXEC_TIMEOUT_MS,
} from './scenarios.ts';

// A ScenarioVerify whose readFile is backed by an in-memory map (null for absent paths). The exec
// capability is attached ONLY when given: absent means the scenario must stay on the static path.
function verifyCtx(
  files: Record<string, string>,
  runTest?: ScenarioVerify['runTest'],
): ScenarioVerify {
  const ctx: ScenarioVerify = {
    slug: 'acme/sandbox',
    defaultBranch: 'main',
    readFile: async (path) => files[path] ?? null,
  };
  if (runTest) ctx.runTest = runTest;
  return ctx;
}

test('scenarioById: resolves a known id, undefined otherwise', () => {
  assert.equal(scenarioById('single-file')?.id, 'single-file');
  assert.equal(scenarioById('nope'), undefined);
});

test('registry invariants: unique ids, non-empty goals, ascending grades', () => {
  const ids = BENCH_SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const s of BENCH_SCENARIOS) {
    assert.ok(s.goal.trim().length > 0, `${s.id}: non-empty goal`);
    assert.ok(s.grade >= 1 && s.grade <= 5, `${s.id}: grade in range`);
  }
  const grades = BENCH_SCENARIOS.map((s) => s.grade);
  assert.deepEqual(
    [...grades].sort((x, y) => x - y),
    grades,
    'registry ordered by grade',
  );
});

test('single-file verify: passes when FOO contains BAR, fails when absent or wrong', async () => {
  const s = scenarioById('single-file');
  assert.ok(s);
  assert.equal((await s.verify(verifyCtx({ FOO: 'BAR here' }))).ok, true);
  assert.equal((await s.verify(verifyCtx({ FOO: 'nope' }))).ok, false);
  assert.equal((await s.verify(verifyCtx({}))).ok, false, 'missing FOO fails');
});

test('multi-file-feature verify: a well-formed module + test passes; a stub test fails', async () => {
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  // A real implementation so the fixture actually satisfies goodTest's assertion (slugify('A B') === 'a-b').
  const goodMod =
    'export function slugify(input: string): string {\n' +
    "  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" +
    '}\n';
  const goodTest =
    "import assert from 'node:assert';\nimport { test } from 'node:test';\nimport { slugify } from './slugify.ts';\ntest('slugify', () => {\n  assert.equal(slugify('A B'), 'a-b');\n  assert.equal(slugify('--Hi There!--'), 'hi-there');\n});\n";
  assert.equal(
    (await s.verify(verifyCtx({ 'src/slugify.ts': goodMod, 'src/slugify.test.ts': goodTest }))).ok,
    true,
  );
  // A test file that references the symbol but carries no test construct / assertion must NOT pass —
  // the static path never runs the test; it only rejects the stub, and runTest executes the produced
  // test when opted in (#308).
  const stubTest = '// slugify tests coming soon\n';
  assert.equal(
    (await s.verify(verifyCtx({ 'src/slugify.ts': goodMod, 'src/slugify.test.ts': stubTest }))).ok,
    false,
    'assertion-free stub fails',
  );
  // A module that never exports the function fails too.
  assert.equal(
    (await s.verify(verifyCtx({ 'src/slugify.ts': '// TODO\n', 'src/slugify.test.ts': goodTest })))
      .ok,
    false,
    'unexported symbol fails',
  );
});

test('cross-file-refactor verify: passes only when both the definition and the call site are renamed', async () => {
  const s = scenarioById('cross-file-refactor');
  assert.ok(s);
  const renamedDef = "export function hello(name: string): string {\n  return 'Hi, ' + name;\n}\n";
  const renamedCall =
    "import { hello } from './greet.ts';\nexport function run() { return hello('world'); }\n";
  assert.equal(
    (await s.verify(verifyCtx({ 'src/greet.ts': renamedDef, 'src/main.ts': renamedCall }))).ok,
    true,
  );
  // Definition renamed but the call site still uses the old name → incomplete → fail.
  const staleCall =
    "import { greet } from './greet.ts';\nexport function run() { return greet('world'); }\n";
  assert.equal(
    (await s.verify(verifyCtx({ 'src/greet.ts': renamedDef, 'src/main.ts': staleCall }))).ok,
    false,
    'a forgotten call site fails',
  );
});

test('multi-file-feature verify: rejects the stubs the first version let through (#308)', async () => {
  // The static path cannot tell a right assertion from a wrong one — that is what running the test
  // does, via the opt-in runTest capability (#308). It CAN reject a test that never exercises the
  // function, which the
  // original four regexes did not: `references` matched a bare mention and `hasAssert` matched the
  // `import assert` line.
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  const mod =
    'export function slugify(input: string): string {\n' +
    "  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" +
    '}\n';
  const verdict = async (test: string): Promise<boolean> =>
    (await s.verify(verifyCtx({ 'src/slugify.ts': mod, 'src/slugify.test.ts': test }))).ok;

  // Names it and imports assert, but never calls it — the old check passed this.
  assert.equal(
    await verdict(
      "import assert from 'node:assert';\nimport { test } from 'node:test';\n" +
        "test('slugify', () => { assert.ok(true); });\n",
    ),
    false,
    'a test that never calls slugify must fail',
  );
  // Calls it, but asserts on something else entirely.
  assert.equal(
    await verdict(
      "import assert from 'node:assert';\nimport { test } from 'node:test';\n" +
        "test('slugify', () => { slugify('A B'); assert.equal(1, 1); });\n",
    ),
    false,
    'an assertion not applied to the call proves nothing about slugify',
  );
  // Asserts on the call, but with a single input — the goal asks for a couple.
  assert.equal(
    await verdict(
      "import assert from 'node:assert';\nimport { test } from 'node:test';\n" +
        "test('slugify', () => { assert.equal(slugify('A B'), 'a-b'); });\n",
    ),
    false,
    'one input is not "a couple"',
  );
  // Two distinct inputs, each asserted on the call → passes.
  assert.equal(
    await verdict(
      "import assert from 'node:assert';\nimport { test } from 'node:test';\n" +
        "test('slugify', () => {\n  assert.equal(slugify('A B'), 'a-b');\n" +
        "  assert.equal(slugify('--Hi--'), 'hi');\n});\n",
    ),
    true,
  );
  // Same input twice is one input, not two.
  assert.equal(
    await verdict(
      "import assert from 'node:assert';\nimport { test } from 'node:test';\n" +
        "test('slugify', () => {\n  assert.equal(slugify('A B'), 'a-b');\n" +
        "  assert.equal(slugify('A B'), 'a-b');\n});\n",
    ),
    false,
    'the same literal twice is still one case',
  );
});

test('multi-file-feature verify: a second call that is never asserted is not a second case (#308)', async () => {
  // Counting every `slugify('...')` let a bare call sit next to one real assertion and read as two
  // inputs, while proving nothing about the second. Inputs come from ASSERTED calls only.
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  const mod =
    'export function slugify(input: string): string {\n' +
    "  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" +
    '}\n';
  const verdict = async (test: string): Promise<boolean> =>
    (await s.verify(verifyCtx({ 'src/slugify.ts': mod, 'src/slugify.test.ts': test }))).ok;

  assert.equal(
    await verdict(
      "import assert from 'node:assert';\nimport { test } from 'node:test';\n" +
        "test('slugify', () => {\n  assert.equal(slugify('A B'), 'a-b');\n  slugify('--Hi--');\n});\n",
    ),
    false,
    'one asserted call plus one bare call is one case, not two',
  );
});

// ---- grade 2 with execution opted in (#308): the produced test's real result decides -----------

// A well-formed static fixture: satisfies every static check, so verify() reaches runTest.
const execMod =
  'export function slugify(input: string): string {\n' +
  "  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n" +
  '}\n';
const execTest =
  "import assert from 'node:assert';\nimport { test } from 'node:test';\n" +
  "import { slugify } from './slugify.ts';\ntest('slugify', () => {\n" +
  "  assert.equal(slugify('A B'), 'a-b');\n  assert.equal(slugify('--Hi--'), 'hi');\n});\n";
const execFiles = { 'src/slugify.ts': execMod, 'src/slugify.test.ts': execTest };

test('multi-file-feature verify: with runTest, a produced test that passes decides the verdict (pass)', async () => {
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  let calls = 0;
  let calledPath = '';
  let calledBudget = 0;
  const passingExec: ScenarioExecResult = {
    exitCode: 0,
    stdout: '# pass 1\n# fail 0\n',
    stderr: '',
    timedOut: false,
  };
  const result = await s.verify(
    verifyCtx(execFiles, async (testPath, timeoutMs) => {
      calls++;
      calledPath = testPath;
      calledBudget = timeoutMs;
      return passingExec;
    }),
  );
  assert.equal(result.ok, true, 'a produced test that actually passes passes the scenario');
  assert.match(result.detail, /src\/slugify\.test\.ts/, 'the pass detail names the executed test');
  assert.equal(calls, 1, 'runTest ran exactly once');
  assert.equal(calledPath, 'src/slugify.test.ts', 'the scenario executes the produced test file');
  assert.equal(calledBudget, TEST_EXEC_TIMEOUT_MS, 'the budget is the pinned TEST_EXEC_TIMEOUT_MS');
});

test('multi-file-feature verify: with runTest, a well-formed test exiting non-zero FAILS', async () => {
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  const result = await s.verify(
    verifyCtx(execFiles, async () => ({
      exitCode: 1,
      stdout: '# fail 1\n',
      stderr: "AssertionError: Expected 'a-b' but got 'nope'",
      timedOut: false,
    })),
  );
  assert.equal(result.ok, false, 'a well-formed test that fails on execution must fail');
  assert.match(result.detail, /exited 1/);
  assert.ok(result.detail.includes("Expected 'a-b'"), 'the detail carries the stderr tail');
});

test('multi-file-feature verify: with runTest, exit 0 with zero executed tests FAILS (an all-skipped test executes nothing)', async () => {
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  // A produced test that skips itself (`test('slugify', { skip: true })`) clears every static check
  // and exits 0 on both runners — the verdict must demand executed-test evidence, not just exit 0.
  const result = await s.verify(
    verifyCtx(execFiles, async () => ({
      exitCode: 0,
      stdout: '# pass 0\n# fail 0\n# skipped 1\n',
      stderr: '',
      timedOut: false,
    })),
  );
  assert.equal(result.ok, false, 'exit 0 with every test skipped must not pass');
  assert.match(result.detail, /no test executed/);
});

test('multi-file-feature verify: with runTest, a hung test past the execution budget FAILS', async () => {
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  const result = await s.verify(
    verifyCtx(execFiles, async () => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    })),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /60000ms execution budget/);
});

test('multi-file-feature verify: with runTest, a command that cannot run at all FAILS', async () => {
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  const result = await s.verify(
    verifyCtx(execFiles, async () => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: 'sandbox checkout to main failed: fatal: bad object',
    })),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /could not execute/);
  assert.match(result.detail, /bad object/, 'the detail carries the underlying error');
});

test('multi-file-feature verify: a static failure short-circuits BEFORE runTest (#308)', async () => {
  const s = scenarioById('multi-file-feature');
  assert.ok(s);
  let calls = 0;
  const result = await s.verify(
    verifyCtx(
      { 'src/slugify.ts': execMod, 'src/slugify.test.ts': '// slugify tests coming soon\n' },
      async () => {
        calls++;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    ),
  );
  assert.equal(result.ok, false, 'the assertion-free stub still fails statically');
  assert.equal(calls, 0, 'the executor is never reached when a static check fails');
});

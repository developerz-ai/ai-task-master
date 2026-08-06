// Pure tests for the benchmark scenario registry (issue #184): lookup, registry invariants, and each
// scenario's verify() predicate driven by a mock file reader (no sandbox needed).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BENCH_SCENARIOS, type ScenarioVerify, scenarioById } from './scenarios.ts';

// A ScenarioVerify whose readFile is backed by an in-memory map (null for absent paths).
function verifyCtx(files: Record<string, string>): ScenarioVerify {
  return {
    slug: 'acme/sandbox',
    defaultBranch: 'main',
    readFile: async (path) => files[path] ?? null,
  };
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
  // the static check is honest about rejecting a stub even though it does not run the test (#308).
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
  // The check cannot tell a right assertion from a wrong one — only running the test could, and that
  // is what #308 is blocked on. It CAN reject a test that never exercises the function, which the
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

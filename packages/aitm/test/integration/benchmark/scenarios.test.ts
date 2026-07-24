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
  const goodMod =
    'export function slugify(input: string): string {\n  return input.toLowerCase();\n}\n';
  const goodTest =
    "import assert from 'node:assert';\nimport { test } from 'node:test';\nimport { slugify } from './slugify.ts';\ntest('slugify', () => { assert.equal(slugify('A B'), 'a-b'); });\n";
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

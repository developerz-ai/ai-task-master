// The graded benchmark scenarios (issue #184). Each pins a fixed goal + repo fixture so a run is
// comparable across models and config (reasoningEffort tiers, fallbackModels on/off, glm vs k3 vs
// sonnet, …). Pure data + a verify() predicate — no I/O here; the runner (bench-runner.ts) seeds the
// fixture, drives `aitm start` (+ `merge-pr`), and calls verify() against the produced default branch.
//
// Grades climb in the number of files and the amount of cross-file reasoning the goal needs, so a
// model comparison sees where a cheaper model starts to break. Three build-shaped scenarios ship here;
// CI-red-fix and review-thread scenarios are a natural extension (same shape, a seeded failing check /
// review comment) and can be appended without touching the runner.

// What a scenario's verify() is handed: the sandbox coordinates plus a reader for the produced code on
// the default branch (decoded file contents, or null when the file is absent).
export type ScenarioVerify = {
  slug: string;
  defaultBranch: string;
  readFile: (path: string) => Promise<string | null>;
};

export type BenchScenario = {
  id: string;
  title: string;
  // 1 = trivial single file, climbing to multi-file + cross-file reasoning.
  grade: 1 | 2 | 3 | 4 | 5;
  // The `aitm start` goal text, pinned so runs are comparable.
  goal: string;
  // Fixture files seeded into the repo before the run, on top of the harness's CLAUDE.md + .aitm.json.
  // Relative path → contents. Absent → just the harness baseline (a bare single-file scenario).
  seedFiles?: Record<string, string>;
  // Run `aitm merge-pr` after `start` (drive CI + threads → merge), then verify on the default branch.
  // Default true. When false, verify runs against the open PR's head branch instead (set by the runner).
  merge?: boolean;
  // The scenario's own pass/fail verdict on the produced code — independent of the loop's self-reported
  // status, so a run that claims success but produced wrong code is caught.
  verify: (v: ScenarioVerify) => Promise<{ ok: boolean; detail: string }>;
};

// Grade 1 — single trivial file. Mirrors the original #19 smoke: the floor every model should clear.
const singleFile: BenchScenario = {
  id: 'single-file',
  title: 'Add a single file with fixed content',
  grade: 1,
  goal: 'add file FOO with content BAR',
  async verify({ readFile }) {
    const foo = await readFile('FOO');
    if (foo === null) return { ok: false, detail: 'FOO missing on the default branch' };
    return { ok: /BAR/.test(foo), detail: `FOO=${JSON.stringify(foo.slice(0, 40))}` };
  },
};

// Grade 2 — a small module plus its own test. Exercises "write behaviour + a test that proves it",
// the core Worker contract. The verdict is STATIC: it confirms the module exports the function and the
// test file references it AND carries a test construct + an assertion (so an empty or assertion-free
// stub fails), but it does NOT execute the produced test — a well-formed test that is actually wrong
// still passes. Running the produced test needs an exec-capable verify against the sandbox's own
// runner, tracked as a follow-up (#308).
const multiFileFeature: BenchScenario = {
  id: 'multi-file-feature',
  title: 'Add a module and a test',
  grade: 2,
  goal:
    'Add a TypeScript module src/slugify.ts that exports a function ' +
    'slugify(input: string): string which lowercases the input and replaces runs of ' +
    'non-alphanumeric characters with single hyphens, trimming leading/trailing hyphens. ' +
    'Also add src/slugify.test.ts with a passing node:test case covering a couple of inputs.',
  // Static, and honest about it: this cannot tell a RIGHT assertion from a wrong one — only running
  // the test could, and running model-produced code unsandboxed is what #308 is blocked on. What it
  // can do is reject the stubs that never exercise the function at all, which the first version let
  // through: `references` matched the name in a comment or a bare import, and `hasAssert` matched the
  // `import assert from 'node:assert'` line of a test body that never asserted anything.
  async verify({ readFile }) {
    const mod = await readFile('src/slugify.ts');
    const test = await readFile('src/slugify.test.ts');
    if (mod === null) return { ok: false, detail: 'src/slugify.ts missing' };
    if (test === null) return { ok: false, detail: 'src/slugify.test.ts missing' };
    const exported = /export\s+(?:function|const)\s+slugify\b/.test(mod);
    const hasTest = /\b(?:test|it|describe)\s*\(/.test(test);
    // CALLS it, rather than merely naming it: an import line alone is not exercising anything.
    const calls = /\bslugify\s*\(/.test(test);
    // An assertion whose subject IS the call — `assert.equal(slugify('A B'), 'a-b')`. A test that
    // imports assert and never applies it to slugify's result proves nothing about slugify.
    const assertsOnCall = /(?:\bassert\b[\w.]*|\bexpect)\s*\(\s*slugify\s*\(/.test(test);
    // "a couple of inputs" per the goal: two distinct string literals passed to it.
    const inputs = new Set([...test.matchAll(/\bslugify\s*\(\s*(['"`])(.*?)\1/g)].map((m) => m[2]));
    const coversTwo = inputs.size >= 2;
    const ok = exported && hasTest && calls && assertsOnCall && coversTwo;
    return {
      ok,
      detail: ok
        ? 'module exports slugify; test calls it, asserts on the call, and covers 2+ inputs'
        : `exported=${exported} hasTest=${hasTest} calls=${calls} assertsOnCall=${assertsOnCall} inputs=${inputs.size}`,
    };
  },
};

// Grade 3 — a cross-file rename. The goal touches every file that names the symbol, so a model that
// edits one file and forgets the call site fails the check.
const crossFileRefactor: BenchScenario = {
  id: 'cross-file-refactor',
  title: 'Rename an exported symbol across files',
  grade: 3,
  goal:
    'Rename the exported function `greet` to `hello` everywhere in the repo — its definition in ' +
    'src/greet.ts and every import and call site (src/main.ts) — keeping behaviour identical.',
  seedFiles: {
    'src/greet.ts': "export function greet(name: string): string {\n  return 'Hi, ' + name;\n}\n",
    'src/main.ts':
      "import { greet } from './greet.ts';\n\nexport function run(): string {\n  return greet('world');\n}\n",
  },
  async verify({ readFile }) {
    const greetFile = await readFile('src/greet.ts');
    const mainFile = await readFile('src/main.ts');
    if (greetFile === null || mainFile === null) {
      return { ok: false, detail: 'src/greet.ts or src/main.ts missing' };
    }
    const defined =
      /export function hello\b/.test(greetFile) && !/export function greet\b/.test(greetFile);
    const called = /\bhello\(/.test(mainFile) && !/\bgreet\(/.test(mainFile);
    const ok = defined && called;
    return {
      ok,
      detail: ok
        ? 'renamed in definition and call site'
        : `defined=${defined} called=${called} (rename incomplete)`,
    };
  },
};

// The registry, ordered by grade. The runner iterates this (or a filtered subset by id).
export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  singleFile,
  multiFileFeature,
  crossFileRefactor,
];

export function scenarioById(id: string): BenchScenario | undefined {
  return BENCH_SCENARIOS.find((s) => s.id === id);
}

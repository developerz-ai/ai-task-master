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
// the default branch (decoded file contents, or null when the file is absent), and — only when the
// runner opted in — a bounded executor for the produced test itself (see ScenarioVerify.runTest).
export type ScenarioVerify = {
  slug: string;
  defaultBranch: string;
  readFile: (path: string) => Promise<string | null>;
  // Execute one produced test file inside the sandbox checkout, bounded by timeoutMs. Absent = the
  // scenario stays static-only (grade 2 keeps its pre-#308 verdict). Present = a static-passing
  // produced test is ALSO executed and its real result decides. Opt-in, never default: this runs
  // MODEL-PRODUCED code, so the runner attaches it only behind an explicit operator gate.
  runTest?: (testPath: string, timeoutMs: number) => Promise<ScenarioExecResult>;
};

// The result of executing one produced test via ScenarioVerify.runTest. exitCode null = the process
// was killed at the timeout (timedOut) or never started; `error` is set ONLY when the command could
// not run at all (tooling unavailable, sandbox sync failed) — a test that ran and failed is
// exitCode !== 0 with captured output, never an `error`.
export type ScenarioExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

// Execution budget handed to runTest for a produced test: generous for a cold loader spin-up plus
// the run, and enforced with SIGKILL by the executor — a hung test is killed, never waited out.
export const TEST_EXEC_TIMEOUT_MS = 60_000;

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
// the core Worker contract. The verdict is STATIC unless execution was opted into (runTest injected):
// test file references it AND carries a test construct + an assertion (so an empty or assertion-free
// stub fails), but they cannot tell a RIGHT assertion from a wrong one — only running the test can.
// With runTest present, a static-passing produced test is ALSO executed ('src/slugify.test.ts',
// TEST_EXEC_TIMEOUT_MS budget) and its real result decides (#308). Scenarios stay I/O-free — they
// only CALL the injected capability; opting in is the runner's call, behind AITM_BENCH_EXEC=1.
const multiFileFeature: BenchScenario = {
  id: 'multi-file-feature',
  title: 'Add a module and a test',
  grade: 2,
  goal:
    'Add a TypeScript module src/slugify.ts that exports a function ' +
    'slugify(input: string): string which lowercases the input and replaces runs of ' +
    'non-alphanumeric characters with single hyphens, trimming leading/trailing hyphens. ' +
    'Also add src/slugify.test.ts with a passing node:test case covering a couple of inputs.',
  // Static first, and honest about the limit: this cannot tell a right assertion from a wrong one —
  // only running the test could, and running model-produced code is opt-in (runTest, AITM_BENCH_EXEC).
  // What the static checks CAN do is reject the stubs that never exercise the function at all, which
  // the first version let through: `references` matched the name in a comment or a bare import, and
  // `hasAssert` matched the `import assert from 'node:assert'` line of a test body that never
  // asserted anything. When execution is opted in, a static-passing test is additionally executed
  // and its real result decides; when it is not, the verdict is byte-for-byte the pre-#308 static one.
  async verify({ readFile, runTest }) {
    const mod = await readFile('src/slugify.ts');
    const test = await readFile('src/slugify.test.ts');
    if (mod === null) return { ok: false, detail: 'src/slugify.ts missing' };
    if (test === null) return { ok: false, detail: 'src/slugify.test.ts missing' };
    const exported = /export\s+(?:function|const)\s+slugify\b/.test(mod);
    const hasTest = /\b(?:test|it|describe)\s*\(/.test(test);
    // CALLS it, rather than merely naming it: an import line alone is not exercising anything.
    const calls = /\bslugify\s*\(/.test(test);
    // Inputs counted ONLY from calls that sit inside an assertion — `assert.equal(slugify('A B'), …)`.
    // Counting every call would let a bare `slugify('--Hi--')` next to one real assertion pass as
    // "two inputs" while proving nothing about the second, which is what the first version did.
    const asserted = new Set(
      [...test.matchAll(/(?:\bassert\b[\w.]*|\bexpect)\s*\(\s*slugify\s*\(\s*(['"`])(.*?)\1/g)].map(
        (m) => m[2],
      ),
    );
    // "a couple of inputs", per the scenario's own goal text.
    const coversTwo = asserted.size >= 2;
    const staticOk = exported && hasTest && calls && coversTwo;
    if (!staticOk) {
      return {
        ok: false,
        detail: `exported=${exported} hasTest=${hasTest} calls=${calls} assertedInputs=${asserted.size}`,
      };
    }
    if (!runTest) {
      return {
        ok: true,
        detail: 'module exports slugify; test asserts on slugify(...) for 2+ distinct inputs',
      };
    }
    const exec = await runTest('src/slugify.test.ts', TEST_EXEC_TIMEOUT_MS);
    if (exec.error !== undefined) {
      return { ok: false, detail: `produced test could not execute: ${exec.error}` };
    }
    if (exec.timedOut) {
      return {
        ok: false,
        detail: `produced test exceeded the ${TEST_EXEC_TIMEOUT_MS}ms execution budget`,
      };
    }
    if (exec.exitCode !== 0) {
      const stderrTail = exec.stderr.length > 0 ? `\n${exec.stderr.slice(-2000)}` : '';
      return { ok: false, detail: `produced test exited ${exec.exitCode}${stderrTail}` };
    }
    // Exit 0 alone proves nothing: node:test and bun both exit 0 when every test was SKIPPED, so
    // `test('slugify', { skip: true }, …)` clears every static check and executes nothing. Require
    // the runner's own executed-test evidence — node:test TAP prints `# pass N`, bun prints
    // `N passed`/`N pass` — and treat zero as a refusal, not a pass.
    const executed = [...exec.stdout.matchAll(/# pass (\d+)|\b(\d+) passed?\b/g)].reduce(
      (max, m) => Math.max(max, Number(m[1] ?? m[2] ?? 0)),
      0,
    );
    if (executed < 1) {
      const stdoutTail = exec.stdout.length > 0 ? `\n${exec.stdout.slice(-2000)}` : '';
      return {
        ok: false,
        detail: `no test executed: exit 0 but stdout reports no passing test (was it skipped?)${stdoutTail}`,
      };
    }
    return {
      ok: true,
      detail:
        'module exports slugify; test asserts on slugify(...) for 2+ distinct inputs; ' +
        'executed src/slugify.test.ts (exit 0)',
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

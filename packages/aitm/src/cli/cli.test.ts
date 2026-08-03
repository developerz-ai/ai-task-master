import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ErrorReporter } from '../observability/error-reporter.ts';
import { makeTempRepo } from '../testing/temp-repo.ts';
import type { EntrypointProcess, MainCtx } from './cli.ts';
import { forceExit, installSignalHandlers, isEntrypoint, main, runEntrypoint } from './cli.ts';

const FAKE_KEY = 'sk-or-fake-test-key';

type Capture = {
  out: string[];
  err: string[];
  ctx: Pick<MainCtx, 'stdout' | 'stderr'>;
};

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    ctx: {
      stdout: (s: string) => {
        out.push(s);
      },
      stderr: (s: string) => {
        err.push(s);
      },
    },
  };
}

async function tempHome(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-cli-home-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

// ---- help ------------------------------------------------------------------

test('main: no args → help on stdout, exit 0', async () => {
  const cap = capture();
  const code = await main([], cap.ctx);
  assert.equal(code, 0);
  assert.equal(cap.err.join(''), '');
  const printed = cap.out.join('');
  assert.match(printed, /^aitm — autonomous task orchestrator/);
  assert.match(printed, /aitm start/);
  assert.match(printed, /aitm merge-pr/);
  assert.match(printed, /aitm config/);
});

test('main: help command → exit 0, usage on stdout', async () => {
  const cap = capture();
  const code = await main(['help'], cap.ctx);
  assert.equal(code, 0);
  assert.match(cap.out.join(''), /Usage:/);
});

test('main: help lists the --branch flag', async () => {
  const cap = capture();
  await main(['help'], cap.ctx);
  assert.match(cap.out.join(''), /--branch/);
});

for (const flag of ['--help', '-h']) {
  test(`main: ${flag} → exit 0, usage on stdout`, async () => {
    const cap = capture();
    const code = await main([flag], cap.ctx);
    assert.equal(code, 0);
    assert.match(cap.out.join(''), /Usage:/);
  });
}

// ---- usage errors ------------------------------------------------------------

test('main: unknown command → usage on stderr, exit 2', async () => {
  const cap = capture();
  const code = await main(['nope'], cap.ctx);
  assert.equal(code, 2);
  assert.equal(cap.out.join(''), '');
  assert.match(cap.err.join(''), /Usage:/);
});

test('main: malformed flag value → usage on stderr, exit 2', async () => {
  const cap = capture();
  const code = await main(['start', 'goal', '--max-prs', 'abc'], cap.ctx);
  assert.equal(code, 2);
  assert.equal(cap.out.join(''), '');
  assert.match(cap.err.join(''), /Usage:/);
});

test('main: missing goal → usage on stderr, exit 2', async () => {
  const cap = capture();
  const code = await main(['start'], cap.ctx);
  assert.equal(code, 2);
  assert.match(cap.err.join(''), /Usage:/);
});

// ---- start dispatch --------------------------------------------------------

test('main: start with stubbed env routes to runStart and forwards exit code', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  try {
    let called = 0;
    const code = await main(['start', 'add jwt auth'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      runLoop: async () => {
        called++;
        return { kind: 'success', outcomes: [] };
      },
    });
    assert.equal(code, 0);
    assert.equal(called, 1);
    const goal = await readFile(join(repo.path, '.ai-task-master', 'goal.txt'), 'utf8');
    assert.equal(goal.trim(), 'add jwt auth');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: start threads ctx.signal into the run loop', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  const controller = new AbortController();
  try {
    let received: AbortSignal | undefined;
    const code = await main(['start', 'goal'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      signal: controller.signal,
      runLoop: async (input) => {
        received = input.signal;
        return { kind: 'success', outcomes: [] };
      },
    });
    assert.equal(code, 0, cap.err.join(''));
    assert.equal(received, controller.signal);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: start without OPENROUTER_API_KEY → exit 1, message on stderr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  try {
    const code = await main(['start', 'goal'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: {},
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      runLoop: async () => {
        assert.fail('runLoop must not be invoked when API key is missing');
      },
    });
    assert.equal(code, 1);
    assert.match(cap.err.join(''), /OPENROUTER_API_KEY|API key/i);
    assert.equal(cap.out.join(''), '');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- merge-pr dispatch -----------------------------------------------------

test('main: merge-pr --pr N with no prior state → exit 0 (take-over path)', async () => {
  // Regression test for the take-over flow: `aitm merge-pr --pr N` from a freshly cloned
  // repo (no prior `aitm start`) should auto-init state and run the flow, mirroring the
  // claude-task-master `merge_pr` behavior.
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  try {
    let flowRan = false;
    const code = await main(['merge-pr', '--pr', '7'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      runMergeFlow: async () => {
        flowRan = true;
        return { kind: 'success', outcomes: [] };
      },
    });
    assert.equal(code, 0, cap.err.join(''));
    assert.equal(flowRan, true);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: merge-pr threads ctx.signal into the merge flow', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  const controller = new AbortController();
  try {
    let received: AbortSignal | undefined;
    const code = await main(['merge-pr', '--pr', '7'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      signal: controller.signal,
      runMergeFlow: async (input) => {
        received = input.signal;
        return { kind: 'success', outcomes: [] };
      },
    });
    assert.equal(code, 0, cap.err.join(''));
    assert.equal(received, controller.signal);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: merge-pr with an aborted signal → flow cancels → exit 2', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  const controller = new AbortController();
  controller.abort();
  try {
    const code = await main(['merge-pr', '--pr', '7'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      signal: controller.signal,
      // Mirrors the real take-over loop: an already-aborted signal short-circuits to cancelled.
      runMergeFlow: async (input) =>
        input.signal?.aborted
          ? { kind: 'cancelled', outcomes: [] }
          : { kind: 'success', outcomes: [] },
    });
    assert.equal(code, 2);
    assert.match(cap.err.join(''), /Cancelled/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- config dispatch -------------------------------------------------------

test('main: config set then get round-trip via stubbed home', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  const setCap = capture();
  const getCap = capture();
  try {
    const setCode = await main(['config', 'set', 'models.smart', 'anthropic/claude-opus-4.7'], {
      ...setCap.ctx,
      cwd: repo.path,
      homeDir: home.path,
    });
    assert.equal(setCode, 0, setCap.err.join(''));

    const raw = await readFile(join(home.path, '.aitm.json'), 'utf8');
    const parsed = JSON.parse(raw) as { models?: { smart?: string } };
    assert.equal(parsed.models?.smart, 'anthropic/claude-opus-4.7');

    const getCode = await main(['config', 'get', 'models.smart'], {
      ...getCap.ctx,
      cwd: repo.path,
      homeDir: home.path,
    });
    assert.equal(getCode, 0);
    assert.equal(getCap.out.join(''), 'anthropic/claude-opus-4.7\n');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: config list → JSON on stdout, exit 0', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  const cap = capture();
  try {
    await writeFile(join(home.path, '.aitm.json'), JSON.stringify({ maxPrs: 9 }));
    const code = await main(['config', 'list'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
    });
    assert.equal(code, 0);
    const printed = JSON.parse(cap.out.join('').trim()) as { maxPrs: number };
    assert.equal(printed.maxPrs, 9);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: config set with invalid value → exit 1, message on stderr', async () => {
  const repo = await makeTempRepo();
  const home = await tempHome();
  const cap = capture();
  try {
    const code = await main(['config', 'set', 'maxPrs', '"five"'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
    });
    assert.equal(code, 1);
    assert.match(cap.err.join(''), /maxPrs/);
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- shebang -----------------------------------------------------------

test('cli.ts source preserves shebang as first line', async () => {
  const here = new URL(import.meta.url).pathname;
  const cliPath = join(here, '..', 'cli.ts');
  const contents = await readFile(cliPath, 'utf8');
  assert.match(contents, /^#!\/usr\/bin\/env node\n/);
});

// ---- entrypoint detection ---------------------------------------------

test('isEntrypoint: direct invocation (argv[1] === real cli path) is true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-ep-'));
  try {
    const cli = join(dir, 'cli.js');
    await writeFile(cli, '// noop');
    assert.equal(isEntrypoint(pathToFileURL(cli).href, cli), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isEntrypoint: symlink invocation resolves through realpath (global-install case)', async () => {
  // Reproduces what `npm i -g .` does: places a symlink at ~/.bun/bin/aitm pointing at
  // dist/cli/cli.js. Without realpath, the equality check failed and the CLI exited
  // silently with no output (the bug this regression test guards against).
  const dir = await mkdtemp(join(tmpdir(), 'aitm-ep-link-'));
  try {
    const real = join(dir, 'cli.js');
    const link = join(dir, 'aitm');
    await writeFile(real, '// noop');
    await symlink(real, link);
    assert.equal(isEntrypoint(pathToFileURL(real).href, link), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isEntrypoint: imported as a module (argv[1] points elsewhere) is false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-ep-other-'));
  try {
    const cli = join(dir, 'cli.js');
    const other = join(dir, 'other.js');
    await writeFile(cli, '// noop');
    await writeFile(other, '// noop');
    assert.equal(isEntrypoint(pathToFileURL(cli).href, other), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isEntrypoint: undefined argv[1] is false (no crash)', () => {
  assert.equal(isEntrypoint('file:///whatever', undefined), false);
});

// ---- message routing: code-0 to stdout, code≥1 to stderr -------------------

test('main: start success (code 0) routes message to stdout, not stderr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  try {
    const code = await main(['start', 'goal'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      runLoop: async () => {
        return { kind: 'success', outcomes: [] };
      },
    });
    assert.equal(code, 0);
    assert.equal(cap.err.join(''), '');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: start session-cap (code 0, message) routes to stdout, not stderr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  try {
    const code = await main(['start', 'goal'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      runLoop: async () => {
        return { kind: 'session-cap', outcomes: [] };
      },
    });
    assert.equal(code, 0);
    assert.match(cap.out.join(''), /Session cap reached/);
    assert.equal(cap.err.join(''), '');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: start awaiting-pr (code 0, message) routes to stdout, not stderr', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  try {
    const code = await main(['start', 'goal'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      runLoop: async () => {
        return { kind: 'awaiting-pr', outcomes: [], prs: [42] };
      },
    });
    assert.equal(code, 0);
    assert.match(cap.out.join(''), /PR\(s\) opened/);
    assert.equal(cap.err.join(''), '');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: start error (code 1, message) routes to stderr, not stdout', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  try {
    const code = await main(['start', 'goal'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: false, scopes: [] }),
    });
    assert.equal(code, 1);
    assert.match(cap.err.join(''), /not authenticated/);
    assert.equal(cap.out.join(''), '');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

test('main: start cancelled (code 2, message) routes to stderr, not stdout', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  const home = await tempHome();
  const cap = capture();
  try {
    const code = await main(['start', 'goal'], {
      ...cap.ctx,
      cwd: repo.path,
      homeDir: home.path,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      authStatus: async () => ({ ok: true, scopes: ['repo'] }),
      runLoop: async () => {
        return { kind: 'cancelled', outcomes: [] };
      },
    });
    assert.equal(code, 2);
    assert.match(cap.err.join(''), /Cancelled/);
    assert.equal(cap.out.join(''), '');
  } finally {
    await repo.cleanup();
    await home.cleanup();
  }
});

// ---- signal handling: abort-then-force-exit --------------------------------

type FakeProc = {
  proc: EntrypointProcess;
  handlers: Map<string, () => void>;
  fire: (name: string) => void;
  errs: string[];
  exits: number[];
};

// A structural process whose exit() throws (like a real process.exit that never returns) so the
// abort/force-exit branches are observable without touching the test-runner process. `off` removes
// its own handler so the entrypoint's post-run detach is observable via `handlers`.
function fakeSignalProc(): FakeProc {
  const handlers = new Map<string, () => void>();
  const errs: string[] = [];
  const exits: number[] = [];
  const proc: EntrypointProcess = {
    on(signal, listener) {
      handlers.set(signal, listener);
    },
    off(signal, listener) {
      if (handlers.get(signal) === listener) handlers.delete(signal);
    },
    exit(code): never {
      exits.push(code);
      throw new Error(`forced-exit:${code}`);
    },
    stderr: {
      write(chunk) {
        errs.push(chunk);
        return true;
      },
    },
  };
  return {
    proc,
    handlers,
    fire: (name) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no handler registered for ${name}`);
      handler();
    },
    errs,
    exits,
  };
}

// A reporter that counts flushes and remembers the last capture — the shutdown's observable seam.
function fakeReporter(): { reporter: ErrorReporter; rec: { flushed: number; captured: unknown } } {
  const rec: { flushed: number; captured: unknown } = { flushed: 0, captured: undefined };
  return {
    rec,
    reporter: {
      captureException: (error) => {
        rec.captured = error;
      },
      flush: async () => {
        rec.flushed += 1;
      },
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test('installSignalHandlers: registers SIGINT and SIGTERM', () => {
  const fake = fakeSignalProc();
  installSignalHandlers(new AbortController(), { proc: fake.proc });
  assert.deepEqual([...fake.handlers.keys()].sort(), ['SIGINT', 'SIGTERM']);
});

test('installSignalHandlers: first SIGINT aborts + warns, second force-exits 130', () => {
  const controller = new AbortController();
  const fake = fakeSignalProc();
  installSignalHandlers(controller, { proc: fake.proc });

  assert.equal(controller.signal.aborted, false);
  fake.fire('SIGINT');
  assert.equal(controller.signal.aborted, true);
  assert.match(fake.errs.join(''), /force-quit/);
  assert.deepEqual(fake.exits, []);

  assert.throws(() => fake.fire('SIGINT'), /forced-exit:130/);
  assert.deepEqual(fake.exits, [130]);
});

test('installSignalHandlers: second SIGTERM force-exits 143', () => {
  const controller = new AbortController();
  const fake = fakeSignalProc();
  installSignalHandlers(controller, { proc: fake.proc });

  fake.fire('SIGTERM');
  assert.equal(controller.signal.aborted, true);
  assert.throws(() => fake.fire('SIGTERM'), /forced-exit:143/);
  assert.deepEqual(fake.exits, [143]);
});

test('installSignalHandlers: the remover detaches every handler', () => {
  const fake = fakeSignalProc();
  const remove = installSignalHandlers(new AbortController(), { proc: fake.proc });
  assert.equal(fake.handlers.size, 2);
  remove();
  assert.equal(fake.handlers.size, 0);
});

test('installSignalHandlers: second signal routes to onForceExit, not a bare exit', () => {
  const controller = new AbortController();
  const fake = fakeSignalProc();
  const forced: number[] = [];
  installSignalHandlers(controller, { proc: fake.proc, onForceExit: (code) => forced.push(code) });

  fake.fire('SIGINT'); // first: abort + warn
  assert.equal(controller.signal.aborted, true);
  fake.fire('SIGINT'); // second: hand off to onForceExit
  assert.deepEqual(forced, [130]);
  assert.deepEqual(fake.exits, [], 'proc.exit must not be called when onForceExit is given');
});

test('forceExit: flushes the reporter exactly once, then exits with the code', async () => {
  const { reporter, rec } = fakeReporter();
  const exits: number[] = [];
  forceExit(reporter, 143, { exit: (code) => exits.push(code) });
  await tick();
  assert.equal(rec.flushed, 1);
  assert.deepEqual(exits, [143]);
});

test('forceExit: exits within the budget even when the flush never resolves', async () => {
  const exits: number[] = [];
  const stuck: ErrorReporter = {
    captureException: () => {},
    flush: () => new Promise<void>(() => {}), // never settles
  };
  forceExit(stuck, 130, { exit: (code) => exits.push(code) }, 1);
  await tick();
  assert.deepEqual(exits, [130]);
});

test('runEntrypoint: sets process.exitCode from main, never hard-exits, flushes + detaches', async () => {
  const fake = fakeSignalProc();
  const { reporter, rec } = fakeReporter();
  await runEntrypoint(reporter, ['whatever'], fake.proc, async () => 0);
  assert.equal(fake.proc.exitCode, 0);
  assert.equal(rec.flushed, 1);
  assert.deepEqual(fake.exits, [], 'the normal path must not call process.exit');
  assert.equal(fake.handlers.size, 0, 'handlers are removed once main resolves');
});

test('runEntrypoint: a throwing main → exitCode 1, captured, message on stderr, still flushes', async () => {
  const fake = fakeSignalProc();
  const { reporter, rec } = fakeReporter();
  const boom = new Error('boom');
  await runEntrypoint(reporter, ['whatever'], fake.proc, async () => {
    throw boom;
  });
  assert.equal(fake.proc.exitCode, 1);
  assert.equal(rec.captured, boom);
  assert.match(fake.errs.join(''), /boom/);
  assert.equal(rec.flushed, 1);
  assert.deepEqual(fake.exits, []);
});

test('runEntrypoint: the first signal aborts the run, handlers gone after it resolves', async () => {
  const fake = fakeSignalProc();
  const { reporter } = fakeReporter();
  let sawAbort = false;
  await runEntrypoint(reporter, ['whatever'], fake.proc, async (_argv, runCtx) => {
    fake.fire('SIGINT'); // user hits Ctrl-C mid-run
    sawAbort = runCtx.signal?.aborted === true;
    return 2;
  });
  assert.equal(sawAbort, true, 'main sees the controller abort on the first signal');
  assert.equal(fake.proc.exitCode, 2);
  assert.equal(fake.handlers.size, 0);
});

test('main: --version prints the installed version and exits 0', async () => {
  // The question an operator asks right after an upgrade. It used to fall through to usage + exit 2,
  // which is how you end up debugging a build you are not running.
  for (const argv of [['--version'], ['-v'], ['version']]) {
    const out: string[] = [];
    const code = await main(argv, { stdout: (c) => out.push(c) });
    assert.equal(code, 0, argv.join(' '));
    // Prerelease/build metadata is valid semver and readVersion prints it verbatim, so the
    // assertion must not reject `1.4.0-rc.1` or `1.4.0+build.7`.
    assert.match(
      out.join(''),
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*\n$/,
      `expected a semver line, got ${out.join('')}`,
    );
  }
});

test('main: the usage text advertises resume and version', async () => {
  const out: string[] = [];
  await main(['help'], { stdout: (c) => out.push(c) });
  const help = out.join('');
  assert.match(help, /aitm resume/);
  assert.match(help, /aitm version \| --version \| -v/);
});

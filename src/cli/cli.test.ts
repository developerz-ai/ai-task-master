import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeTempRepo } from '../testing/temp-repo.ts';
import type { MainCtx } from './cli.ts';
import { isEntrypoint, main } from './cli.ts';

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

for (const flag of ['--help', '-h']) {
  test(`main: ${flag} → exit 0, usage on stdout`, async () => {
    const cap = capture();
    const code = await main([flag], cap.ctx);
    assert.equal(code, 0);
    assert.match(cap.out.join(''), /Usage:/);
  });
}

test('main: unknown command → falls through to help, exit 0', async () => {
  const cap = capture();
  const code = await main(['nope'], cap.ctx);
  assert.equal(code, 0);
  assert.match(cap.out.join(''), /Usage:/);
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

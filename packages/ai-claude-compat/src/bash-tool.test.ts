import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { execa } from 'execa';
import { ProcessManager, type SpawnFn } from './background-process.ts';
import { type BashOutput, bashTool, MAX_BASH_OUTPUT_CHARS, multiBashTool } from './bash-tool.ts';
import { ToolOutputStore } from './tool-output-store.ts';

function textOf(t: { toModelOutput?: unknown }, input: unknown, output: unknown): string {
  const fn = t.toModelOutput;
  if (typeof fn !== 'function') throw new Error('tool has no toModelOutput');
  const part = (
    fn as (o: { toolCallId: string; input: unknown; output: unknown }) => {
      type: string;
      value: string;
    }
  )({ toolCallId: 'c', input, output });
  assert.equal(part.type, 'text');
  return part.value;
}

test('toModelOutput: bash renders stdout/stderr/exit conditionally; clean empty → (no output) (issue #127)', () => {
  const bash = bashTool({ cwd: '/tmp/x' });
  assert.equal(
    textOf(bash, { command: 'x' }, { stdout: 'hello\n', stderr: '', exitCode: 0 }),
    'hello\n',
  );
  assert.equal(
    textOf(bash, { command: 'x' }, { stdout: '', stderr: '', exitCode: 0 }),
    '(no output)',
  );
  assert.ok(
    !/exit code/.test(textOf(bash, { command: 'x' }, { stdout: 'ok', stderr: '', exitCode: 0 })),
    'no exit-code line on success',
  );
  const failed = textOf(bash, { command: 'x' }, { stdout: 'out', stderr: 'boom', exitCode: 2 });
  assert.match(failed, /stderr:\nboom/);
  assert.match(failed, /exit code: 2/);
});

test('toModelOutput: multiBash renders labeled per-command sections and names the failing command (issue #127)', () => {
  const mb = multiBashTool({ cwd: '/tmp/x' });
  const out = textOf(
    mb,
    { commands: ['a', 'b'] },
    {
      results: [
        { command: 'a', stdout: 'ok', stderr: '', exitCode: 0 },
        { command: 'b', stdout: '', stderr: 'nope', exitCode: 1 },
      ],
      exitCode: 1,
      failedAt: 1,
    },
  );
  assert.match(out, /\$ a\nok/);
  assert.match(out, /\$ b\nstderr:\nnope\nexit code: 1/);
  assert.match(out, /\[command #2 failed: b\]/);
});

async function tempDir(
  prefix = 'compat-bash-',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function run<I, O>(t: { execute?: unknown }, input: I): Promise<O> {
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('tool has no execute');
  return (await (exec as (i: I, o: { toolCallId: string; messages: never[] }) => Promise<O>)(
    input,
    {
      toolCallId: 'test',
      messages: [],
    },
  )) as O;
}

test('bashTool: runs a command inside the worktree', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'sub'), { recursive: true });
    await writeFile(join(dir.path, 'sub', 'marker'), '');
    const out = await run<{ command: string }, { stdout: string; exitCode: number }>(
      bashTool({ cwd: dir.path }),
      { command: 'ls sub' },
    );
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /marker/);
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: non-zero exit is captured, not thrown', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ command: string }, { exitCode: number; stderr: string }>(
      bashTool({ cwd: dir.path }),
      { command: 'false' },
    );
    assert.equal(out.exitCode, 1);
    assert.equal(typeof out.stderr, 'string');
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: command timeout returns non-zero exit, not a thrown rejection', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ command: string }, { exitCode: number }>(
      bashTool({ cwd: dir.path, defaultTimeoutMs: 50 }),
      { command: 'sleep 5' },
    );
    assert.notEqual(out.exitCode, 0);
  } finally {
    await dir.cleanup();
  }
});

type MultiOut = {
  results: Array<{ command: string; stdout: string; exitCode: number }>;
  exitCode: number;
  failedAt: number | null;
};

test('multiBashTool: runs commands in sequence, all succeed', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ commands: string[] }, MultiOut>(multiBashTool({ cwd: dir.path }), {
      commands: ['echo one', 'echo two', 'echo three'],
    });
    assert.equal(out.exitCode, 0);
    assert.equal(out.failedAt, null);
    assert.equal(out.results.length, 3);
    assert.match(out.results[0]?.stdout ?? '', /one/);
    assert.match(out.results[2]?.stdout ?? '', /three/);
  } finally {
    await dir.cleanup();
  }
});

test('multiBashTool: stops at the first failure and skips the rest', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ commands: string[] }, MultiOut>(multiBashTool({ cwd: dir.path }), {
      commands: ['echo first', 'false', 'echo never > marker'],
    });
    assert.notEqual(out.exitCode, 0);
    assert.equal(out.failedAt, 1);
    // The third command must not have run — no marker file.
    assert.equal(out.results.length, 2);
    const check = await run<{ command: string }, { exitCode: number }>(
      bashTool({ cwd: dir.path }),
      {
        command: 'test -f marker',
      },
    );
    assert.notEqual(check.exitCode, 0);
  } finally {
    await dir.cleanup();
  }
});

test('multiBashTool: each command gets a fresh cwd (cd does not leak)', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'sub'), { recursive: true });
    const out = await run<{ commands: string[] }, MultiOut>(multiBashTool({ cwd: dir.path }), {
      commands: ['cd sub', 'pwd'],
    });
    assert.equal(out.exitCode, 0);
    // The second command's pwd is the worktree root, not sub — the cd in command 1 was scoped.
    assert.equal(out.results[1]?.stdout.endsWith('/sub'), false);
  } finally {
    await dir.cleanup();
  }
});

// ---- issue #103: truncation, persistent cwd, description, run_in_background, 120s default ----

// Records the effective timeout the exec seam receives; resolves instantly (never spawns).
function timeoutSpyExec(): { exec: typeof execa; timeouts: number[] } {
  const timeouts: number[] = [];
  const stub = (_file: string, _args: readonly string[], opts: { timeout?: number }) => {
    timeouts.push(opts.timeout ?? -1);
    const p = Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) as Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }> & { pid: number };
    p.pid = 4242;
    return p;
  };
  return { exec: stub as unknown as typeof execa, timeouts };
}

// A ProcessManager spawn that never launches a real process — enough for start()/killAll().
function fakeSpawn(): SpawnFn {
  const stream = { on: () => stream };
  const proc = { stdout: stream, stderr: stream, on: () => proc, kill: () => true, pid: 5150 };
  return (() => proc) as unknown as SpawnFn;
}

test('bashTool: default timeout is 120s and per-call timeoutMs is capped at 600s (issue #103)', async () => {
  const a = timeoutSpyExec();
  await run(bashTool({ cwd: '/w', exec: a.exec }), { command: 'echo hi', description: 'greet' });
  assert.equal(a.timeouts[0], 120_000);

  const b = timeoutSpyExec();
  await run(bashTool({ cwd: '/w', exec: b.exec }), {
    command: 'echo hi',
    description: 'greet',
    timeoutMs: 900_000,
  });
  assert.equal(b.timeouts[0], 600_000);
});

test('bashTool: input schema requires description; run_in_background never fails validation (issue #103)', () => {
  const schema = bashTool({ cwd: '/w' }).inputSchema as unknown as {
    safeParse: (v: unknown) => { success: boolean };
  };
  assert.equal(schema.safeParse({ command: 'ls' }).success, false);
  assert.equal(schema.safeParse({ command: 'ls', description: 'list' }).success, true);
  assert.equal(
    schema.safeParse({ command: 'ls', description: 'list', run_in_background: true }).success,
    true,
  );
  assert.equal(
    schema.safeParse({ command: 'ls', description: 'list', run_in_background: false }).success,
    true,
  );
});

test('bashTool: description text carries the contract + file-tool steering (issue #103)', () => {
  const desc = bashTool({ cwd: '/w' }).description ?? '';
  assert.match(desc, /working directory PERSISTS/i);
  assert.match(desc, /variables, functions.*does NOT|does NOT/i);
  assert.match(desc, /cat.*head.*tail.*sed.*awk.*echo/i);
  assert.match(desc, /dedicated read\/edit\/grep tools/i);
  assert.match(desc, /Use the `gh` CLI for GitHub/i);
  assert.match(desc, /milliseconds \(default 120000, ceiling 600000\)/i);
  assert.match(desc, /run_in_background/);
});

test('bashTool: stdout over the cap is truncated, keeping head + tail + a notice (issue #103)', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ command: string; description: string }, { stdout: string }>(
      bashTool({ cwd: dir.path }),
      { command: `head -c 40000 /dev/zero | tr '\\0' a; echo END_OF_OUTPUT`, description: 'big' },
    );
    assert.ok(out.stdout.length <= MAX_BASH_OUTPUT_CHARS + 200, 'capped near the limit');
    assert.match(out.stdout, /\[output truncated: \d+ chars total/);
    assert.match(out.stdout, /^a+/, 'original head present');
    assert.match(out.stdout, /END_OF_OUTPUT/, 'original tail present');
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: cwd persists across calls; a timed-out call leaves it unchanged (issue #103)', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'sub'), { recursive: true });
    const t = bashTool({ cwd: dir.path });
    await run(t, { command: 'cd sub', description: 'enter sub' });
    const pwd1 = await run<{ command: string; description: string }, { stdout: string }>(t, {
      command: 'pwd',
      description: 'where',
    });
    assert.ok(pwd1.stdout.trim().endsWith('/sub'), `expected .../sub, got ${pwd1.stdout.trim()}`);

    // A timed-out command emits no marker → the tracked cwd stays at /sub.
    await run(t, { command: 'sleep 5', description: 'hang', timeoutMs: 50 });
    const pwd2 = await run<{ command: string; description: string }, { stdout: string }>(t, {
      command: 'pwd',
      description: 'where again',
    });
    assert.ok(pwd2.stdout.trim().endsWith('/sub'), 'timeout did not corrupt cwd');
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: a non-zero exit is preserved and the cwd marker never leaks into stdout (issue #103)', async () => {
  const dir = await tempDir();
  try {
    const out = await run<
      { command: string; description: string },
      { stdout: string; exitCode: number }
    >(bashTool({ cwd: dir.path }), { command: 'echo before; (exit 3)', description: 'fail 3' });
    assert.equal(out.exitCode, 3);
    assert.match(out.stdout, /before/);
    assert.equal(out.stdout.includes('__AITM_CWD__'), false);
    assert.equal(out.stdout.includes('\x00'), false);
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: output containing NUL bytes still strips only the trailing cwd marker (issue #103)', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ command: string; description: string }, { stdout: string }>(
      bashTool({ cwd: dir.path }),
      { command: `printf 'a\\000b'`, description: 'nul output' },
    );
    assert.ok(out.stdout.includes('\x00'), "the command's own NUL survives");
    assert.equal(out.stdout.includes('__AITM_CWD__'), false, 'our marker is gone');
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: run_in_background routes to the ProcessManager and returns a bg id (issue #103)', async () => {
  const manager = new ProcessManager({ cwd: '/w', spawn: fakeSpawn() });
  try {
    const out = await run<
      { command: string; description: string; run_in_background: boolean },
      { stdout: string; exitCode: number }
    >(bashTool({ cwd: '/w', processManager: manager }), {
      command: 'sleep 100',
      description: 'dev server',
      run_in_background: true,
    });
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /Started background process bg-1/);
    assert.match(out.stdout, /bashOutput/);
  } finally {
    manager.killAll();
  }
});

test('bashTool: run_in_background without a manager runs in the foreground with a notice (issue #103)', async () => {
  const dir = await tempDir();
  try {
    const out = await run<
      { command: string; description: string; run_in_background: boolean },
      { stdout: string; exitCode: number }
    >(bashTool({ cwd: dir.path }), {
      command: 'echo ran-in-fg',
      description: 'x',
      run_in_background: true,
    });
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /ran-in-fg/);
    assert.match(out.stdout, /no background process manager/i);
  } finally {
    await dir.cleanup();
  }
});

test('multiBashTool: each command output is truncated per command (issue #103)', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ commands: string[] }, MultiOut>(multiBashTool({ cwd: dir.path }), {
      commands: [`head -c 40000 /dev/zero | tr '\\0' a`],
    });
    const first = out.results[0]?.stdout ?? '';
    assert.ok(first.length <= MAX_BASH_OUTPUT_CHARS + 200);
    assert.match(first, /\[output truncated/);
  } finally {
    await dir.cleanup();
  }
});

// --- tool-output spill: overflow routes through the store instead of destructive head/tail ---

test('bashTool: overflow spills the FULL stream to the store; model output carries the path + paging hint', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(join(dir.path, 'tool-output'));
    const out = await run<{ command: string; description: string }, { stdout: string }>(
      bashTool({ cwd: dir.path, outputStore: store }),
      { command: 'seq 1 20000', description: 'many lines' },
    );
    // The in-context view stays within the cap and carries the spill notice: line count + path + hint.
    assert.ok(out.stdout.length <= MAX_BASH_OUTPUT_CHARS, 'in-context view stays within the cap');
    const m = out.stdout.match(
      /\[output truncated: (\d+) lines omitted\. Full output: (\S+) — page with readFile\(offset\/limit\) or grep\]/,
    );
    assert.ok(m, `spill notice with path + hint present; tail was: ${out.stdout.slice(-200)}`);
    assert.ok(Number(m[1] ?? '') > 0, 'reports a positive omitted-line count');
    // Head + tail are still shown in-context (a trailing summary survives).
    assert.match(out.stdout, /^1\n/, 'head shown in-context');
    assert.match(out.stdout, /20000/, 'tail shown in-context');
    // The spilled file holds the FULL, untruncated stream — including the omitted middle line.
    const full = await readFile(m[2] ?? '', 'utf8');
    assert.ok(full.length > MAX_BASH_OUTPUT_CHARS, 'spill file is the full stream, past the cap');
    assert.ok(full.startsWith('1\n'), 'head preserved in the spill file');
    assert.match(full, /\n10000\n/, 'omitted middle preserved in the spill file');
    assert.match(full, /\n20000\n$/, 'tail preserved in the spill file');
  } finally {
    await dir.cleanup();
  }
});

test('multiBashTool: overflow spills each command output to the store with a paging notice', async () => {
  const dir = await tempDir();
  try {
    const store = new ToolOutputStore(join(dir.path, 'tool-output'));
    const out = await run<{ commands: string[] }, MultiOut>(
      multiBashTool({ cwd: dir.path, outputStore: store }),
      { commands: ['seq 1 20000'] },
    );
    const stdout = out.results[0]?.stdout ?? '';
    const m = stdout.match(/Full output: (\S+) — page with readFile\(offset\/limit\) or grep\]/);
    assert.ok(m, 'multiBash spill notice with path + hint present');
    const full = await readFile(m[1] ?? '', 'utf8');
    assert.ok(full.length > MAX_BASH_OUTPUT_CHARS, 'spill file is the full stream');
    assert.match(full, /\n10000\n/, 'full content spilled, nothing lost');
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: a spill write failure degrades to legacy head/tail truncation, never throws', async () => {
  const dir = await tempDir();
  try {
    class FailingStore extends ToolOutputStore {
      override save(): Promise<never> {
        return Promise.reject(new Error('spill failed'));
      }
    }
    const out = await run<
      { command: string; description: string },
      { stdout: string; exitCode: number }
    >(bashTool({ cwd: dir.path, outputStore: new FailingStore(join(dir.path, 'to')) }), {
      command: `head -c 40000 /dev/zero | tr '\\0' a; echo END_OF_OUTPUT`,
      description: 'big',
    });
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /\[output truncated: \d+ chars total/, 'fell back to legacy notice');
    assert.match(out.stdout, /END_OF_OUTPUT/, 'tail preserved by the fallback');
  } finally {
    await dir.cleanup();
  }
});

// --- command deny/allow governance (issue #113) ---

// Records the argv of every spawn so a denial test can assert the command never ran.
function recordingExec(): { exec: typeof execa; calls: string[] } {
  const calls: string[] = [];
  const stub = async (_file: string, args: readonly string[]) => {
    calls.push(args.join(' '));
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { exec: stub as unknown as typeof execa, calls };
}

test('bashTool: a denied command returns a typed denial (exit 126) without spawning (issue #113)', async () => {
  const rec = recordingExec();
  const out = await run<{ command: string }, BashOutput>(
    bashTool({
      cwd: '/w',
      exec: rec.exec,
      rules: [{ pattern: 'git push --force*', action: 'deny' }],
    }),
    { command: 'git push --force' },
  );
  assert.equal(out.exitCode, 126);
  assert.equal(out.denied, true);
  assert.match(out.stderr, /blocked by rule `git push --force\*`/);
  assert.match(out.stderr, /do not retry/i);
  assert.equal(out.stdout, '');
  assert.equal(rec.calls.length, 0, 'the denied command was never spawned');
});

test('bashTool: a command not matched by any rule runs normally; omitting rules is unchanged (issue #113)', async () => {
  const rec = recordingExec();
  const out = await run<{ command: string }, BashOutput>(
    bashTool({
      cwd: '/w',
      exec: rec.exec,
      rules: [{ pattern: 'git push --force*', action: 'deny' }],
    }),
    { command: 'git status' },
  );
  assert.equal(out.exitCode, 0);
  assert.notEqual(out.denied, true);
  assert.equal(rec.calls.length, 1, 'a non-matching command spawns');
});

test('multiBashTool: a denied command sets failedAt and skips the remaining commands (issue #113)', async () => {
  const rec = recordingExec();
  const out = await run<
    { commands: string[] },
    MultiOut & { results: Array<{ denied?: boolean }> }
  >(
    multiBashTool({
      cwd: '/w',
      exec: rec.exec,
      rules: [{ pattern: 'git push -f', action: 'deny' }],
    }),
    { commands: ['echo before', 'git push -f', 'echo after'] },
  );
  assert.equal(out.failedAt, 1);
  assert.equal(out.exitCode, 126);
  assert.equal(out.results.length, 2, 'ran cmd 0, denied cmd 1, skipped cmd 2');
  assert.equal(out.results[1]?.denied, true);
  assert.equal(rec.calls.length, 1, 'only the first command spawned');
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashTool, multiBashTool } from './bash-tool.ts';

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

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashTool } from './bash-tool.ts';

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

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFileTool, writeFileTool } from './fs-tools.ts';

async function tempDir(
  prefix = 'compat-fs-',
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

test('readFileTool: reads the whole file by default', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'l1\nl2\nl3\n');
    const out = await run<{ path: string }, { content: string }>(readFileTool({ cwd: dir.path }), {
      path: 'f.txt',
    });
    assert.equal(out.content, 'l1\nl2\nl3\n');
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: offset+limit returns a 1-based line window', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const out = await run<{ path: string; offset: number; limit: number }, { content: string }>(
      readFileTool({ cwd: dir.path }),
      { path: 'f.txt', offset: 2, limit: 2 },
    );
    assert.equal(out.content, 'l2\nl3');
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: a window running to EOF keeps the trailing newline', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'l1\nl2\nl3\n');
    const out = await run<{ path: string; offset: number }, { content: string }>(
      readFileTool({ cwd: dir.path }),
      { path: 'f.txt', offset: 2 },
    );
    assert.equal(out.content, 'l2\nl3\n');
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: offset past EOF returns empty', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'l1\nl2\n');
    const out = await run<{ path: string; offset: number }, { content: string }>(
      readFileTool({ cwd: dir.path }),
      { path: 'f.txt', offset: 99 },
    );
    assert.equal(out.content, '');
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: rejects a path escaping the worktree', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => run(readFileTool({ cwd: dir.path }), { path: '../etc/passwd' }),
      /path escapes worktree/,
    );
  } finally {
    await dir.cleanup();
  }
});

test('writeFileTool: creates a file and parent dirs inside the worktree', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ path: string; content: string }, { ok: boolean }>(
      writeFileTool({ cwd: dir.path }),
      { path: 'a/b/c.txt', content: 'nested\n' },
    );
    assert.equal(out.ok, true);
    assert.equal(await readFile(join(dir.path, 'a/b/c.txt'), 'utf8'), 'nested\n');
  } finally {
    await dir.cleanup();
  }
});

test('writeFileTool: rejects a write outside the worktree', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => run(writeFileTool({ cwd: dir.path }), { path: '../escape.txt', content: 'x' }),
      /path escapes worktree/,
    );
  } finally {
    await dir.cleanup();
  }
});

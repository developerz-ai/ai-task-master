import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileStateTracker } from './file-state.ts';
import { readFileTool, writeFileTool } from './fs-tools.ts';

async function tempDir(
  prefix = 'compat-fs-',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

// One tracker shared by the file tools, as in a real tool set.
function tools(cwd: string) {
  const fileState = new FileStateTracker();
  return {
    fileState,
    read: readFileTool({ cwd, fileState }),
    write: writeFileTool({ cwd, fileState }),
  };
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

type ReadIn = { path: string; offset?: number; limit?: number };
type ReadOut = { content: string };

test('readFileTool: renders cat -n numbered lines for a window (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    // A window that runs to EOF (limit exceeds the remaining lines) → no continuation notice.
    const out = await run<ReadIn, ReadOut>(tools(dir.path).read, {
      path: 'f.txt',
      offset: 2,
      limit: 10,
    });
    assert.equal(out.content, '2\tl2\n3\tl3\n4\tl4\n5\tl5');
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: caps at 2000 lines by default and names the next offset (issue #104)', async () => {
  const dir = await tempDir();
  try {
    const big = Array.from({ length: 2001 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(dir.path, 'big.txt'), `${big}\n`);
    const out = await run<ReadIn, ReadOut>(tools(dir.path).read, { path: 'big.txt' });
    assert.match(out.content, /^1\tline1\n/);
    assert.match(out.content, /\n2000\tline2000/);
    assert.equal(out.content.includes('2001\tline2001'), false);
    assert.match(out.content, /showing lines 1-2000; more remain — continue with offset: 2001/);
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: directory, missing, and empty paths return informative messages (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'adir'));
    await writeFile(join(dir.path, 'empty.txt'), '');
    const t = tools(dir.path);
    const asDir = await run<ReadIn, ReadOut>(t.read, { path: 'adir' });
    assert.match(asDir.content, /is a directory/);
    const missing = await run<ReadIn, ReadOut>(t.read, { path: 'nope.txt' });
    assert.match(missing.content, /File not found/);
    assert.equal(missing.content.includes('ENOENT'), false);
    const empty = await run<ReadIn, ReadOut>(t.read, { path: 'empty.txt' });
    assert.match(empty.content, /empty \(0 bytes\)/);
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: offset past the end explains itself (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'l1\nl2\n');
    const out = await run<ReadIn, ReadOut>(tools(dir.path).read, { path: 'f.txt', offset: 99 });
    assert.match(out.content, /past the last line/);
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: an over-long line is truncated with a marker (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'long.txt'), `${'x'.repeat(3000)}\n`);
    const out = await run<ReadIn, ReadOut>(tools(dir.path).read, { path: 'long.txt' });
    assert.match(out.content, /\[line truncated: 3000 chars\]/);
    assert.ok(out.content.length < 3000);
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: rejects a path escaping the worktree', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => run(tools(dir.path).read, { path: '../etc/passwd' }),
      /path escapes worktree/,
    );
  } finally {
    await dir.cleanup();
  }
});

test('writeFileTool: creates a new file (and parent dirs) without a prior read (issue #104)', async () => {
  const dir = await tempDir();
  try {
    const out = await run<{ path: string; content: string }, { ok: boolean }>(
      tools(dir.path).write,
      {
        path: 'a/b/c.txt',
        content: 'nested\n',
      },
    );
    assert.equal(out.ok, true);
    assert.equal(await readFile(join(dir.path, 'a/b/c.txt'), 'utf8'), 'nested\n');
  } finally {
    await dir.cleanup();
  }
});

test('writeFileTool: overwriting an existing unread file fails; succeeds after a read (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'original\n');
    const t = tools(dir.path);
    await assert.rejects(
      () => run(t.write, { path: 'f.txt', content: 'clobber\n' }),
      /was not Read this run/,
    );
    // Original is untouched.
    assert.equal(await readFile(join(dir.path, 'f.txt'), 'utf8'), 'original\n');
    // After a read, the overwrite is allowed.
    await run<ReadIn, ReadOut>(t.read, { path: 'f.txt' });
    const ok = await run<{ path: string; content: string }, { ok: boolean }>(t.write, {
      path: 'f.txt',
      content: 'replaced\n',
    });
    assert.equal(ok.ok, true);
    assert.equal(await readFile(join(dir.path, 'f.txt'), 'utf8'), 'replaced\n');
  } finally {
    await dir.cleanup();
  }
});

test('writeFileTool: rejects a write outside the worktree', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => run(tools(dir.path).write, { path: '../escape.txt', content: 'x' }),
      /path escapes worktree/,
    );
  } finally {
    await dir.cleanup();
  }
});

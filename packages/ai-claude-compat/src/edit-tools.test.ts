import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdit, editFileTool, multiEditTool } from './edit-tools.ts';

async function tempDir(
  prefix = 'compat-edit-',
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

// ---- applyEdit (pure) ----

test('applyEdit: replaces a unique occurrence', () => {
  const { next, count } = applyEdit('hello world', { oldString: 'world', newString: 'there' });
  assert.equal(next, 'hello there');
  assert.equal(count, 1);
});

test('applyEdit: throws when oldString is absent', () => {
  assert.throws(() => applyEdit('abc', { oldString: 'z', newString: 'y' }), /not found/);
});

test('applyEdit: throws on ambiguous oldString without replaceAll', () => {
  assert.throws(
    () => applyEdit('a a a', { oldString: 'a', newString: 'b' }),
    /not unique \(3 matches\)/,
  );
});

test('applyEdit: replaceAll replaces every occurrence', () => {
  const { next, count } = applyEdit('a a a', { oldString: 'a', newString: 'b', replaceAll: true });
  assert.equal(next, 'b b b');
  assert.equal(count, 3);
});

test('applyEdit: newString with $ tokens is inserted verbatim', () => {
  const { next } = applyEdit('x', { oldString: 'x', newString: '$&$1' });
  assert.equal(next, '$&$1');
});

// ---- editFileTool ----

test('editFileTool: writes the replacement back to disk', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'const a = 1;\n');
    const out = await run<
      { path: string; oldString: string; newString: string },
      { replacements: number }
    >(editFileTool({ cwd: dir.path }), { path: 'f.txt', oldString: 'a = 1', newString: 'a = 2' });
    assert.equal(out.replacements, 1);
    assert.equal(await readFile(join(dir.path, 'f.txt'), 'utf8'), 'const a = 2;\n');
  } finally {
    await dir.cleanup();
  }
});

test('editFileTool: rejects a path escaping the worktree', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => run(editFileTool({ cwd: dir.path }), { path: '../x', oldString: 'a', newString: 'b' }),
      /path escapes worktree/,
    );
  } finally {
    await dir.cleanup();
  }
});

// ---- multiEditTool ----

test('multiEditTool: applies edits in order and writes once', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'one two three\n');
    const out = await run<
      { path: string; edits: { oldString: string; newString: string }[] },
      { replacements: number }
    >(multiEditTool({ cwd: dir.path }), {
      path: 'f.txt',
      edits: [
        { oldString: 'one', newString: '1' },
        { oldString: 'three', newString: '3' },
      ],
    });
    assert.equal(out.replacements, 2);
    assert.equal(await readFile(join(dir.path, 'f.txt'), 'utf8'), '1 two 3\n');
  } finally {
    await dir.cleanup();
  }
});

test('multiEditTool: is atomic — a failing edit leaves the file untouched', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'keep me\n');
    await assert.rejects(
      () =>
        run(multiEditTool({ cwd: dir.path }), {
          path: 'f.txt',
          edits: [
            { oldString: 'keep', newString: 'changed' },
            { oldString: 'absent', newString: 'x' },
          ],
        }),
      /edit 2\/2: oldString not found/,
    );
    assert.equal(await readFile(join(dir.path, 'f.txt'), 'utf8'), 'keep me\n');
  } finally {
    await dir.cleanup();
  }
});

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdit, editFileTool, multiEditTool } from './edit-tools.ts';
import { FileStateTracker } from './file-state.ts';
import { readFileTool } from './fs-tools.ts';

async function tempDir(
  prefix = 'compat-edit-',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

function tools(cwd: string) {
  const fileState = new FileStateTracker();
  return {
    fileState,
    read: readFileTool({ cwd, fileState }),
    edit: editFileTool({ cwd, fileState }),
    multiEdit: multiEditTool({ cwd, fileState }),
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

test('toModelOutput: edit/multiEdit confirm the replacement count and carry the numbered snippet (issue #127)', () => {
  const { edit, multiEdit } = tools('/tmp/x');
  const one = textOf(
    edit,
    { path: 'a.ts' },
    { ok: true, replacements: 1, snippet: '1\tconst a = 2' },
  );
  assert.match(one, /Applied 1 replacement to a\.ts\./);
  assert.match(one, /1\tconst a = 2/, 'numbered snippet included verbatim');
  const many = textOf(multiEdit, { path: 'b.ts' }, { ok: true, replacements: 3, snippet: '4\tx' });
  assert.match(many, /Applied 3 replacements to b\.ts\./, 'plural count');
});

// ---- applyEdit (pure) ----

test('applyEdit: replaces a unique occurrence', () => {
  const { next, count } = applyEdit('hello world', { oldString: 'world', newString: 'there' });
  assert.equal(next, 'hello there');
  assert.equal(count, 1);
});

test('applyEdit: throws when oldString is absent', () => {
  assert.throws(() => applyEdit('abc', { oldString: 'z', newString: 'y' }), /not found/);
});

test('applyEdit: rejects an empty oldString', () => {
  assert.throws(() => applyEdit('abc', { oldString: '', newString: 'y' }), /must be non-empty/);
});

test('applyEdit: rejects identical oldString and newString (issue #104)', () => {
  assert.throws(() => applyEdit('abc', { oldString: 'a', newString: 'a' }), /identical/);
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

test('editFileTool: fails without a prior read; succeeds after one and returns a numbered snippet (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'const a = 1;\nconst b = 2;\n');
    const t = tools(dir.path);
    await assert.rejects(
      () => run(t.edit, { path: 'f.txt', oldString: 'a = 1', newString: 'a = 2' }),
      /was not Read this run/,
    );
    // Read populates the tracker; now the edit lands and reports a snippet.
    await run(t.read, { path: 'f.txt' });
    const out = await run<
      { path: string; oldString: string; newString: string },
      { replacements: number; snippet: string }
    >(t.edit, { path: 'f.txt', oldString: 'a = 1', newString: 'a = 99' });
    assert.equal(out.replacements, 1);
    assert.equal(await readFile(join(dir.path, 'f.txt'), 'utf8'), 'const a = 99;\nconst b = 2;\n');
    assert.match(out.snippet, /1\tconst a = 99;/);
  } finally {
    await dir.cleanup();
  }
});

test('editFileTool: rejects an edit against content changed on disk since the read (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'v1 content\n');
    const t = tools(dir.path);
    await run(t.read, { path: 'f.txt' });
    // Something else changes the file after the read.
    await writeFile(join(dir.path, 'f.txt'), 'externally rewritten\n');
    await assert.rejects(
      () => run(t.edit, { path: 'f.txt', oldString: 'externally', newString: 'x' }),
      /modified since you read it/,
    );
  } finally {
    await dir.cleanup();
  }
});

test('editFileTool: an immediate follow-up edit needs no re-read (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'alpha beta gamma\n');
    const t = tools(dir.path);
    await run(t.read, { path: 'f.txt' });
    await run(t.edit, { path: 'f.txt', oldString: 'alpha', newString: 'A' });
    // No re-read — the previous edit refreshed the tracker.
    const out = await run<
      { path: string; oldString: string; newString: string },
      { replacements: number }
    >(t.edit, { path: 'f.txt', oldString: 'gamma', newString: 'G' });
    assert.equal(out.replacements, 1);
    assert.equal(await readFile(join(dir.path, 'f.txt'), 'utf8'), 'A beta G\n');
  } finally {
    await dir.cleanup();
  }
});

test('editFileTool: preserves an executable file’s mode across the edit (issue #104)', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir.path, 'run.sh');
    await writeFile(file, '#!/bin/sh\necho hi\n');
    await chmod(file, 0o755);
    const t = tools(dir.path);
    await run(t.read, { path: 'run.sh' });
    await run(t.edit, { path: 'run.sh', oldString: 'hi', newString: 'bye' });
    assert.equal((await stat(file)).mode & 0o777, 0o755);
  } finally {
    await dir.cleanup();
  }
});

test('editFileTool: rejects a path escaping the worktree', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      () => run(tools(dir.path).edit, { path: '../x', oldString: 'a', newString: 'b' }),
      /path escapes worktree/,
    );
  } finally {
    await dir.cleanup();
  }
});

// ---- multiEditTool ----

test('multiEditTool: applies edits in order and writes once (after a read) (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'one two three\n');
    const t = tools(dir.path);
    await run(t.read, { path: 'f.txt' });
    const out = await run<
      { path: string; edits: { oldString: string; newString: string }[] },
      { replacements: number }
    >(t.multiEdit, {
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

test('multiEditTool: is atomic — a failing edit leaves the file untouched (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'keep me\n');
    const t = tools(dir.path);
    await run(t.read, { path: 'f.txt' });
    await assert.rejects(
      () =>
        run(t.multiEdit, {
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

test('multiEditTool: fails without a prior read (issue #104)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'x\n');
    await assert.rejects(
      () =>
        run(tools(dir.path).multiEdit, {
          path: 'f.txt',
          edits: [{ oldString: 'x', newString: 'y' }],
        }),
      /was not Read this run/,
    );
  } finally {
    await dir.cleanup();
  }
});

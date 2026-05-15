import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashTool, readFileTool, writeFileTool } from './fs-tools.ts';

async function tempDir(
  prefix = 'aitm-fs-',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

// Invoking tool.execute requires the (input, opts) signature SDK uses. Wrap it so tests
// don't pollute every assertion with a fake toolCallId / messages stub.
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

// ---- readFile ----

test('readFileTool: reads a file inside the worktree', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'hello.txt'), 'hi\n');
    const t = readFileTool({ cwd: dir.path });
    const out = await run<{ path: string }, { content: string }>(t, { path: 'hello.txt' });
    assert.equal(out.content, 'hi\n');
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: rejects ../ escape via relative path', async () => {
  const dir = await tempDir();
  try {
    const t = readFileTool({ cwd: dir.path });
    await assert.rejects(() => run(t, { path: '../etc/passwd' }), /path escapes worktree/);
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: rejects absolute path outside worktree', async () => {
  const dir = await tempDir();
  try {
    const t = readFileTool({ cwd: dir.path });
    await assert.rejects(() => run(t, { path: '/etc/hostname' }), /path escapes worktree/);
  } finally {
    await dir.cleanup();
  }
});

test('readFileTool: rejects symlink that points outside the worktree', async () => {
  const dir = await tempDir();
  const outside = await tempDir('aitm-fs-out-');
  try {
    await writeFile(join(outside.path, 'secret.txt'), 'secret\n');
    await symlink(join(outside.path, 'secret.txt'), join(dir.path, 'link.txt'));
    const t = readFileTool({ cwd: dir.path });
    await assert.rejects(() => run(t, { path: 'link.txt' }), /escapes worktree via symlink/);
  } finally {
    await dir.cleanup();
    await outside.cleanup();
  }
});

// ---- writeFile ----

test('writeFileTool: creates a file inside the worktree, including parent dirs', async () => {
  const dir = await tempDir();
  try {
    const t = writeFileTool({ cwd: dir.path });
    const out = await run<{ path: string; content: string }, { ok: boolean }>(t, {
      path: 'a/b/c.txt',
      content: 'nested\n',
    });
    assert.equal(out.ok, true);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(join(dir.path, 'a/b/c.txt'), 'utf8'), 'nested\n');
  } finally {
    await dir.cleanup();
  }
});

test('writeFileTool: rejects write outside the worktree', async () => {
  const dir = await tempDir();
  try {
    const t = writeFileTool({ cwd: dir.path });
    await assert.rejects(
      () => run(t, { path: '../escape.txt', content: 'x' }),
      /path escapes worktree/,
    );
  } finally {
    await dir.cleanup();
  }
});

test('writeFileTool: rejects write through a parent symlink pointing outside', async () => {
  const dir = await tempDir();
  const outside = await tempDir('aitm-fs-out-');
  try {
    // dir/escape -> outside (a symlinked directory). Writing dir/escape/foo.txt would
    // land in outside/foo.txt, which is outside the worktree.
    await symlink(outside.path, join(dir.path, 'escape'));
    const t = writeFileTool({ cwd: dir.path });
    await assert.rejects(
      () => run(t, { path: 'escape/foo.txt', content: 'x' }),
      /escapes worktree via symlink/,
    );
  } finally {
    await dir.cleanup();
    await outside.cleanup();
  }
});

// ---- bash ----

test('bashTool: runs a command inside the worktree', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'sub'), { recursive: true });
    await writeFile(join(dir.path, 'sub', 'marker'), '');
    const t = bashTool({ cwd: dir.path });
    const out = await run<{ command: string }, { stdout: string; exitCode: number }>(t, {
      command: 'ls sub',
    });
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /marker/);
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: non-zero exit is captured, not thrown', async () => {
  const dir = await tempDir();
  try {
    const t = bashTool({ cwd: dir.path });
    const out = await run<{ command: string }, { exitCode: number; stderr: string }>(t, {
      command: 'false',
    });
    assert.equal(out.exitCode, 1);
    assert.equal(typeof out.stderr, 'string');
  } finally {
    await dir.cleanup();
  }
});

test('bashTool: command timeout returns non-zero exit, not a thrown rejection', async () => {
  const dir = await tempDir();
  try {
    const t = bashTool({ cwd: dir.path, defaultTimeoutMs: 50 });
    const out = await run<{ command: string }, { exitCode: number }>(t, { command: 'sleep 5' });
    assert.notEqual(out.exitCode, 0);
  } finally {
    await dir.cleanup();
  }
});

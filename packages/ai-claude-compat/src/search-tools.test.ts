import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { globTool, globToRegExp, grepTool } from './search-tools.ts';

async function tempDir(
  prefix = 'compat-search-',
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

async function fixture(root: string): Promise<void> {
  await mkdir(join(root, 'src/sub'), { recursive: true });
  await mkdir(join(root, 'node_modules/dep'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\nconst secret = 2;\n');
  await writeFile(join(root, 'src/sub/b.ts'), 'export const b = 3;\n');
  await writeFile(join(root, 'src/c.txt'), 'plain text\n');
  await writeFile(join(root, 'node_modules/dep/index.ts'), 'export const SECRET = 9;\n');
}

// ---- globToRegExp ----

test('globToRegExp: * stays within a path segment', () => {
  assert.match('a.ts', globToRegExp('*.ts'));
  assert.doesNotMatch('x/a.ts', globToRegExp('*.ts'));
});

test('globToRegExp: **/ spans directories incl. zero', () => {
  const re = globToRegExp('**/*.ts');
  assert.match('a.ts', re);
  assert.match('x/a.ts', re);
  assert.match('x/y/a.ts', re);
});

test('globToRegExp: ? matches one non-slash char', () => {
  assert.match('ab', globToRegExp('a?'));
  assert.doesNotMatch('a/', globToRegExp('a?'));
});

// ---- globTool ----

test('globTool: lists matching files, skips node_modules', async () => {
  const dir = await tempDir();
  try {
    await fixture(dir.path);
    const out = await run<{ pattern: string }, { files: string[] }>(globTool({ cwd: dir.path }), {
      pattern: '**/*.ts',
    });
    assert.deepEqual(out.files, ['src/a.ts', 'src/sub/b.ts']);
  } finally {
    await dir.cleanup();
  }
});

// ---- grepTool ----

test('grepTool: returns path:line:text matches', async () => {
  const dir = await tempDir();
  try {
    await fixture(dir.path);
    const out = await run<{ pattern: string }, { matches: string[] }>(grepTool({ cwd: dir.path }), {
      pattern: 'export const',
    });
    assert.ok(out.matches.includes('src/a.ts:1:export const a = 1;'));
    assert.ok(out.matches.includes('src/sub/b.ts:1:export const b = 3;'));
    // node_modules is skipped
    assert.ok(!out.matches.some((m) => m.startsWith('node_modules/')));
  } finally {
    await dir.cleanup();
  }
});

test('grepTool: ignoreCase + glob filter', async () => {
  const dir = await tempDir();
  try {
    await fixture(dir.path);
    const out = await run<
      { pattern: string; ignoreCase: boolean; glob: string },
      { matches: string[] }
    >(grepTool({ cwd: dir.path }), { pattern: 'secret', ignoreCase: true, glob: 'src/*.ts' });
    assert.deepEqual(out.matches, ['src/a.ts:2:const secret = 2;']);
  } finally {
    await dir.cleanup();
  }
});

test('grepTool: filesWithMatches returns one path per file', async () => {
  const dir = await tempDir();
  try {
    await fixture(dir.path);
    const out = await run<{ pattern: string; filesWithMatches: boolean }, { matches: string[] }>(
      grepTool({ cwd: dir.path }),
      { pattern: 'const', filesWithMatches: true },
    );
    assert.deepEqual(out.matches.sort(), ['src/a.ts', 'src/sub/b.ts']);
  } finally {
    await dir.cleanup();
  }
});

test('grepTool: maxResults caps and flags truncation', async () => {
  const dir = await tempDir();
  try {
    await fixture(dir.path);
    const out = await run<
      { pattern: string; maxResults: number },
      { matches: string[]; truncated: boolean }
    >(grepTool({ cwd: dir.path }), { pattern: 'const', maxResults: 1 });
    assert.equal(out.matches.length, 1);
    assert.equal(out.truncated, true);
  } finally {
    await dir.cleanup();
  }
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  globInputSchema,
  globTool,
  globToRegExp,
  grepInputSchema,
  grepTool,
} from './search-tools.ts';

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
    // Order is mtime-driven now; assert the set (skips node_modules).
    assert.deepEqual([...out.files].sort(), ['src/a.ts', 'src/sub/b.ts']);
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

test('grepTool: filesWithMatches respects maxResults and truncation', async () => {
  const dir = await tempDir();
  try {
    await fixture(dir.path);
    const out = await run<
      { pattern: string; filesWithMatches: boolean; maxResults: number },
      { matches: string[]; truncated: boolean }
    >(grepTool({ cwd: dir.path }), { pattern: 'const', filesWithMatches: true, maxResults: 1 });
    assert.equal(out.matches.length, 1);
    assert.equal(out.truncated, true);
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

// ---- brace alternation (issue #110) ----

test('globToRegExp: {a,b} alternation matches each alternate, not the literal braces', () => {
  const re = globToRegExp('*.{ts,tsx}');
  assert.match('a.ts', re);
  assert.match('b.tsx', re);
  assert.doesNotMatch('a.js', re);
  assert.doesNotMatch('a.{ts,tsx}', re);
});

test('globToRegExp: nested braces and **/ compose', () => {
  const re = globToRegExp('**/*.{ts,{md,mdx}}');
  assert.match('x/y/a.ts', re);
  assert.match('a.md', re);
  assert.match('deep/b.mdx', re);
  assert.doesNotMatch('a.js', re);
});

test('globToRegExp: an unmatched { stays literal', () => {
  const re = globToRegExp('a{b');
  assert.match('a{b', re);
  assert.doesNotMatch('ab', re);
});

test('globTool + grep glob: **/*.{ts,tsx} returns both extensions (was zero, silently)', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'src'), { recursive: true });
    await writeFile(join(dir.path, 'src/a.ts'), 'const a = 1; // needle\n');
    await writeFile(join(dir.path, 'src/b.tsx'), 'const b = 2; // needle\n');
    await writeFile(join(dir.path, 'src/c.js'), 'const c = 3; // needle\n');

    const glob = await run<{ pattern: string }, { files: string[] }>(globTool({ cwd: dir.path }), {
      pattern: '**/*.{ts,tsx}',
    });
    assert.deepEqual([...glob.files].sort(), ['src/a.ts', 'src/b.tsx']);

    const grep = await run<{ pattern: string; glob: string }, { matches: string[] }>(
      grepTool({ cwd: dir.path }),
      { pattern: 'needle', glob: '**/*.{ts,tsx}' },
    );
    assert.deepEqual(grep.matches.map((m) => m.split(':')[0]).sort(), ['src/a.ts', 'src/b.tsx']);
  } finally {
    await dir.cleanup();
  }
});

// ---- context lines (issue #110) ----

test('grepTool: contextAfter/Before render rg-style blocks clamped at file boundaries', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'l1\nl2\nMATCH\nl4\nl5\n');
    const out = await run<
      { pattern: string; contextBefore: number; contextAfter: number },
      { matches: string[] }
    >(grepTool({ cwd: dir.path }), { pattern: 'MATCH', contextBefore: 1, contextAfter: 1 });
    assert.deepEqual(out.matches, ['f.txt-2-l2', 'f.txt:3:MATCH', 'f.txt-4-l4']);
  } finally {
    await dir.cleanup();
  }
});

test('grepTool: context clamps at line 1 (no line 0) and EOF (no past-EOF)', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'MATCH\nl2\n');
    const out = await run<
      { pattern: string; contextBefore: number; contextAfter: number },
      { matches: string[] }
    >(grepTool({ cwd: dir.path }), { pattern: 'MATCH', contextBefore: 3, contextAfter: 3 });
    // Only real lines 1-2; no phantom line 0 or line 3.
    assert.deepEqual(out.matches, ['f.txt:1:MATCH', 'f.txt-2-l2']);
  } finally {
    await dir.cleanup();
  }
});

test('grepTool: adjacent context regions merge; non-contiguous blocks split with --', async () => {
  const dir = await tempDir();
  try {
    // matches on lines 2 and 4 with ctx 1 → regions [1..3] and [3..5] merge into one block. Scope
    // each call with a glob so a co-resident fixture file cannot leak in.
    await writeFile(join(dir.path, 'm.txt'), 'a\nX\nc\nX\ne\n');
    const merged = await run<
      { pattern: string; contextAfter: number; contextBefore: number; glob: string },
      { matches: string[] }
    >(grepTool({ cwd: dir.path }), {
      pattern: 'X',
      contextBefore: 1,
      contextAfter: 1,
      glob: 'm.txt',
    });
    assert.deepEqual(merged.matches, [
      'm.txt-1-a',
      'm.txt:2:X',
      'm.txt-3-c',
      'm.txt:4:X',
      'm.txt-5-e',
    ]);
    assert.ok(!merged.matches.includes('--'), 'contiguous → no separator');

    // matches on lines 1 and 6 with ctx 1 → two non-contiguous blocks separated by --.
    await writeFile(join(dir.path, 'n.txt'), 'X\nb\nc\nd\ne\nX\n');
    const split = await run<
      { pattern: string; contextAfter: number; glob: string },
      { matches: string[] }
    >(grepTool({ cwd: dir.path }), { pattern: 'X', contextAfter: 1, glob: 'n.txt' });
    assert.deepEqual(split.matches, ['n.txt:1:X', 'n.txt-2-b', '--', 'n.txt:6:X']);
  } finally {
    await dir.cleanup();
  }
});

test('grepTool: context params are ignored in filesWithMatches and count modes', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'f.txt'), 'l1\nX\nl3\n');
    const fwm = await run<
      { pattern: string; contextAfter: number; filesWithMatches: boolean },
      { matches: string[] }
    >(grepTool({ cwd: dir.path }), { pattern: 'X', contextAfter: 2, filesWithMatches: true });
    assert.deepEqual(fwm.matches, ['f.txt']);
    const cnt = await run<
      { pattern: string; contextAfter: number; count: boolean },
      { matches: string[] }
    >(grepTool({ cwd: dir.path }), { pattern: 'X', contextAfter: 2, count: true });
    assert.deepEqual(cnt.matches, ['f.txt:1']);
  } finally {
    await dir.cleanup();
  }
});

// ---- count mode (issue #110) ----

test('grepTool: count returns per-file match counts, omitting zero-match files', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 's'), { recursive: true });
    await writeFile(join(dir.path, 's/a.txt'), 'x\nx\ny\n');
    await writeFile(join(dir.path, 's/b.txt'), 'x\n');
    await writeFile(join(dir.path, 's/c.txt'), 'nothing here\n');
    const out = await run<{ pattern: string; count: boolean }, { matches: string[] }>(
      grepTool({ cwd: dir.path }),
      { pattern: 'x', count: true },
    );
    assert.deepEqual([...out.matches].sort(), ['s/a.txt:2', 's/b.txt:1']);
  } finally {
    await dir.cleanup();
  }
});

test('grepInputSchema: count + filesWithMatches together is a schema error', () => {
  assert.equal(grepInputSchema.safeParse({ pattern: 'x', count: true }).success, true);
  assert.equal(grepInputSchema.safeParse({ pattern: 'x', filesWithMatches: true }).success, true);
  assert.equal(
    grepInputSchema.safeParse({ pattern: 'x', count: true, filesWithMatches: true }).success,
    false,
  );
  assert.equal(globInputSchema.safeParse({ pattern: '*' }).success, true);
});

// ---- mtime sort (issue #110) ----

test('globTool: sorts newest-first by mtime, path-ascending on ties', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'd'), { recursive: true });
    await writeFile(join(dir.path, 'd/old.ts'), '1\n');
    await writeFile(join(dir.path, 'd/new.ts'), '2\n');
    await writeFile(join(dir.path, 'd/tieA.ts'), '3\n');
    await writeFile(join(dir.path, 'd/tieB.ts'), '4\n');
    // Explicit mtimes: new (t=300) > tieA=tieB (t=200) > old (t=100).
    await utimes(join(dir.path, 'd/old.ts'), 100, 100);
    await utimes(join(dir.path, 'd/new.ts'), 300, 300);
    await utimes(join(dir.path, 'd/tieA.ts'), 200, 200);
    await utimes(join(dir.path, 'd/tieB.ts'), 200, 200);
    const out = await run<{ pattern: string }, { files: string[] }>(globTool({ cwd: dir.path }), {
      pattern: 'd/*.ts',
    });
    assert.deepEqual(out.files, ['d/new.ts', 'd/tieA.ts', 'd/tieB.ts', 'd/old.ts']);
  } finally {
    await dir.cleanup();
  }
});

// ---- .gitignore + hidden dirs (issue #110) ----

test('walk honors root and nested .gitignore for both tools', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'src/gen'), { recursive: true });
    await mkdir(join(dir.path, 'dist'), { recursive: true });
    await writeFile(join(dir.path, '.gitignore'), 'dist/\n*.log\n');
    await writeFile(join(dir.path, 'src/.gitignore'), 'gen/\n');
    await writeFile(join(dir.path, 'src/keep.ts'), 'needle\n');
    await writeFile(join(dir.path, 'src/gen/out.ts'), 'needle\n');
    await writeFile(join(dir.path, 'dist/bundle.ts'), 'needle\n');
    await writeFile(join(dir.path, 'app.log'), 'needle\n');

    const glob = await run<{ pattern: string }, { files: string[] }>(globTool({ cwd: dir.path }), {
      pattern: '**/*.ts',
    });
    assert.deepEqual([...glob.files].sort(), ['src/keep.ts']);

    const grep = await run<{ pattern: string }, { matches: string[] }>(
      grepTool({ cwd: dir.path }),
      {
        pattern: 'needle',
      },
    );
    assert.deepEqual(grep.matches.map((m) => m.split(':')[0]).sort(), ['src/keep.ts']);
  } finally {
    await dir.cleanup();
  }
});

test('walk skips hidden dirs by default, keeps .github, and includeHidden opens them', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, '.cache'), { recursive: true });
    await mkdir(join(dir.path, '.github/workflows'), { recursive: true });
    await writeFile(join(dir.path, '.cache/x.ts'), '1\n');
    await writeFile(join(dir.path, '.github/workflows/ci.ts'), '2\n');
    await writeFile(join(dir.path, 'app.ts'), '3\n');

    const def = await run<{ pattern: string }, { files: string[] }>(globTool({ cwd: dir.path }), {
      pattern: '**/*.ts',
    });
    assert.deepEqual([...def.files].sort(), ['.github/workflows/ci.ts', 'app.ts']);

    const all = await run<{ pattern: string; includeHidden: boolean }, { files: string[] }>(
      globTool({ cwd: dir.path }),
      { pattern: '**/*.ts', includeHidden: true },
    );
    assert.deepEqual([...all.files].sort(), ['.cache/x.ts', '.github/workflows/ci.ts', 'app.ts']);
  } finally {
    await dir.cleanup();
  }
});

// ---- guards preserved (issue #110) ----

test('grepTool: still skips NUL-binary and oversized files, and does not follow symlinks', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'text.txt'), 'needle\n');
    await writeFile(join(dir.path, 'bin.dat'), `nee${String.fromCharCode(0)}dle\n`);
    await symlink(join(dir.path, 'text.txt'), join(dir.path, 'link.txt')).catch(() => {});
    const out = await run<{ pattern: string }, { matches: string[] }>(grepTool({ cwd: dir.path }), {
      pattern: 'needle',
    });
    // Only the real text file; the binary is skipped and the symlink is not followed.
    assert.deepEqual(out.matches, ['text.txt:1:needle']);
  } finally {
    await dir.cleanup();
  }
});

test('grepTool description steers content search away from bash grep/rg', () => {
  const desc = grepTool({ cwd: '/tmp' }).description ?? '';
  assert.match(desc, /never invoke `grep` or `rg` through the bash tool/);
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandImports } from './expand-imports.ts';

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aitm-imports-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('content with no imports is returned unchanged', async () => {
  await withDir(async (dir) => {
    const input = '# Title\n\nsome text with no imports\n';
    assert.equal(await expandImports(input, dir), input);
  });
});

test('a single @-import is inlined at its position', async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, 'core'), { recursive: true });
    await writeFile(join(dir, 'core', 'AGENTS.md'), 'RULE: human-merge only\n');
    const out = await expandImports('before\n@core/AGENTS.md\nafter\n', dir);
    assert.match(out, /before\nRULE: human-merge only\n\nafter\n/);
  });
});

test('nested imports expand recursively', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'a.md'), 'A-top @b.md A-bottom\n');
    await writeFile(join(dir, 'b.md'), 'B has @c.md\n');
    await writeFile(join(dir, 'c.md'), 'DEEP\n');
    const out = await expandImports('@a.md\n', dir);
    assert.match(out, /A-top/);
    assert.match(out, /B has/);
    assert.match(out, /DEEP/);
  });
});

test('a cycle terminates without hanging', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'a.md'), 'A @b.md\n');
    await writeFile(join(dir, 'b.md'), 'B @a.md\n');
    const out = await expandImports('@a.md\n', dir);
    // the second re-entry to a.md is blocked by the visited-guard and left literal
    assert.match(out, /A/);
    assert.match(out, /B/);
    assert.match(out, /@a\.md/);
  });
});

test('a self-import terminates', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'a.md'), 'X @a.md Y\n');
    const out = await expandImports('@a.md\n', dir);
    assert.match(out, /X .*@a\.md.* Y/);
  });
});

test('a missing import is left as literal text', async () => {
  await withDir(async (dir) => {
    const out = await expandImports('see @core/MISSING.md here\n', dir);
    assert.equal(out, 'see @core/MISSING.md here\n');
  });
});

test('@ inside a fenced code block is not expanded', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'x.md'), 'INLINED\n');
    const input = '```\n@x.md\n```\n';
    assert.equal(await expandImports(input, dir), input);
  });
});

test('@ inside an inline code span is not expanded', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'x.md'), 'INLINED\n');
    const input = 'use `@x.md` verbatim\n';
    assert.equal(await expandImports(input, dir), input);
  });
});

test('email-like @ (preceded by a word char) is not treated as an import', async () => {
  await withDir(async (dir) => {
    const input = 'contact me@example.com for help\n';
    assert.equal(await expandImports(input, dir), input);
  });
});

test('an escaped @@ is not treated as an import', async () => {
  await withDir(async (dir) => {
    const input = 'literal @@core/AGENTS.md stays\n';
    assert.equal(await expandImports(input, dir), input);
  });
});

test('imports escaping the root boundary are refused (left literal)', async () => {
  await withDir(async (dir) => {
    const root = join(dir, 'repo');
    await mkdir(root, { recursive: true });
    await writeFile(join(dir, 'outside.md'), 'SECRET\n');
    const out = await expandImports('@../outside.md\n', root, { root });
    assert.equal(out, '@../outside.md\n');
    assert.doesNotMatch(out, /SECRET/);
  });
});

test('~-home imports are refused (left literal)', async () => {
  await withDir(async (dir) => {
    const out = await expandImports('@~/.ssh/id_rsa\n', dir, { root: dir });
    assert.equal(out, '@~/.ssh/id_rsa\n');
  });
});

test('nesting beyond maxDepth leaves the deep import literal', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'a.md'), 'A @b.md\n');
    await writeFile(join(dir, 'b.md'), 'B @c.md\n');
    await writeFile(join(dir, 'c.md'), 'C-deep\n');
    const out = await expandImports('@a.md\n', dir, { maxDepth: 1 });
    // depth 1 inlines a.md; a.md's own @b.md import is at depth 2 → not followed
    assert.match(out, /A/);
    assert.match(out, /@b\.md/);
    assert.doesNotMatch(out, /C-deep/);
  });
});

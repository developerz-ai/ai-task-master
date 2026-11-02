import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempRepo } from '../testing/temp-repo.ts';
import { runTool } from '../testing/tool-harness.ts';
import {
  readContainedFile,
  STYLE_EXPLORATION_MAX_FILE_BYTES,
  styleExplorationTools,
} from './style-exploration.ts';

const STYLE_TEXT = '# Style\n\n- use spaces, not tabs\n';

test('styleExplorationTools offers exactly one tool, and it only reads', () => {
  const tools = styleExplorationTools('/repo');
  assert.deepEqual(Object.keys(tools), ['readRepoFile']);
});

test('readContainedFile returns an in-root file verbatim', async () => {
  const repo = await makeTempRepo();
  try {
    await mkdir(join(repo.path, 'docs'), { recursive: true });
    await writeFile(join(repo.path, 'docs', 'STYLE.md'), STYLE_TEXT);
    const read = await readContainedFile(repo.path, 'docs/STYLE.md');
    assert.equal(read, STYLE_TEXT);
  } finally {
    await repo.cleanup();
  }
});

test('readContainedFile refuses a path that does not exist', async () => {
  const repo = await makeTempRepo();
  try {
    const read = await readContainedFile(repo.path, 'docs/NOPE.md');
    assert.match(read, /^refused:/);
    assert.match(read, /does not exist/);
  } finally {
    await repo.cleanup();
  }
});

test('readContainedFile refuses a traversal out of the repo root', async () => {
  const repo = await makeTempRepo();
  try {
    const read = await readContainedFile(repo.path, '../outside.md');
    assert.match(read, /^refused:/);
    assert.match(read, /outside the repository root/);
  } finally {
    await repo.cleanup();
  }
});

test('readContainedFile refuses a symlink resolving outside the repo root', async () => {
  const repo = await makeTempRepo();
  const outside = await mkdtemp(join(tmpdir(), 'aitm-outside-'));
  try {
    const secret = join(outside, 'secret.md');
    await writeFile(secret, 'OUTSIDE_SECRET\n');
    await symlink(secret, join(repo.path, 'link.md'));
    const read = await readContainedFile(repo.path, 'link.md');
    assert.match(read, /^refused:/);
    assert.match(read, /outside the repository root/);
    assert.ok(!read.includes('OUTSIDE_SECRET'), 'the linked file never came back');
  } finally {
    await repo.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('readContainedFile refuses a dot-prefixed path', async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.path, '.env'), 'DOT_SECRET=1\n');
    const read = await readContainedFile(repo.path, '.env');
    assert.match(read, /^refused:/);
    assert.match(read, /dot-prefixed/);
    assert.ok(!read.includes('DOT_SECRET'), 'the dot file never came back');
  } finally {
    await repo.cleanup();
  }
});

test('readContainedFile refuses a directory', async () => {
  const repo = await makeTempRepo();
  try {
    await mkdir(join(repo.path, 'docs'), { recursive: true });
    const read = await readContainedFile(repo.path, 'docs');
    assert.match(read, /^refused:/);
    assert.match(read, /directory/);
  } finally {
    await repo.cleanup();
  }
});

test('readContainedFile refuses a non-regular file without reading it', async (t) => {
  const repo = await makeTempRepo();
  try {
    const fifo = join(repo.path, 'pipe');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== 'ENOENT') throw err;
      t.skip('mkfifo is unavailable on this platform');
      return;
    }
    const read = await readContainedFile(repo.path, 'pipe');
    assert.match(read, /^refused:/);
    assert.match(read, /not a regular file/);
    assert.equal(read.trim().split('\n').length, 1, 'nothing was read out of the special file');
  } finally {
    await repo.cleanup();
  }
});

test('readContainedFile truncates an oversize file instead of failing', async () => {
  const repo = await makeTempRepo();
  try {
    const body = 'x'.repeat(STYLE_EXPLORATION_MAX_FILE_BYTES + 4096);
    await writeFile(join(repo.path, 'big.md'), body);
    const read = await readContainedFile(repo.path, 'big.md');
    assert.ok(read.startsWith('xxxx'), 'the head of the file still comes back');
    assert.match(read, /truncated/, 'the truncation is marked for the model');
    assert.ok(read.length < body.length, 'the oversize file did not come back whole');
  } finally {
    await repo.cleanup();
  }
});

test('readContainedFile truncates a file cut mid-character without a dangling glyph', async () => {
  const repo = await makeTempRepo();
  try {
    // A 3-byte character sitting on the byte cap: the read cuts it in half.
    const euro = '\u20AC';
    const body = `${'a'.repeat(STYLE_EXPLORATION_MAX_FILE_BYTES - 1)}${euro}`;
    await writeFile(join(repo.path, 'euro.md'), body);
    const read = await readContainedFile(repo.path, 'euro.md');
    assert.match(read, /truncated/, 'the truncation is marked for the model');
    assert.ok(
      read.startsWith('a'.repeat(STYLE_EXPLORATION_MAX_FILE_BYTES - 1)),
      'the text before the cut comes back whole',
    );
    assert.ok(
      !read.includes('\uFFFD'),
      'the split character left no dangling replacement character',
    );
  } finally {
    await repo.cleanup();
  }
});

test('the readRepoFile tool answers a refused path with a string, never a throw', async () => {
  const repo = await makeTempRepo();
  try {
    const tools = styleExplorationTools(repo.path);
    const out = await runTool(tools.readRepoFile, { path: '../outside.md' });
    assert.equal(typeof out, 'string');
    assert.match(out, /^refused:/);
  } finally {
    await repo.cleanup();
  }
});

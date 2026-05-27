import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envBlock } from './env-block.ts';

test('envBlock wraps the fields in an <env> block with the working directory', () => {
  const out = envBlock({ cwd: '/tmp/work', date: '2026-05-27' });
  assert.match(out, /^<env>\n/);
  assert.match(out, /\n<\/env>$/);
  assert.match(out, /Working directory: \/tmp\/work/);
  assert.match(out, /Platform: /);
  assert.match(out, /Today's date: 2026-05-27/);
});

test('envBlock includes the git-repo line only when isGitRepo is set', () => {
  assert.match(envBlock({ cwd: '/r', isGitRepo: true }), /Is directory a git repo: Yes/);
  assert.match(envBlock({ cwd: '/r', isGitRepo: false }), /Is directory a git repo: No/);
  assert.doesNotMatch(envBlock({ cwd: '/r' }), /Is directory a git repo/);
});

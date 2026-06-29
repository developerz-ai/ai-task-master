import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGitAllowed, GitGuardError, runGit } from './git-exec.ts';

test('assertGitAllowed: rejects plain force-push', () => {
  assert.throws(() => assertGitAllowed(['push', '--force']), GitGuardError);
  assert.throws(() => assertGitAllowed(['push', '-f']), GitGuardError);
  assert.throws(() => assertGitAllowed(['push', '--force=origin']), GitGuardError);
  assert.throws(() => assertGitAllowed(['push', '-u', 'origin', 'br', '--force']), GitGuardError);
});

test('assertGitAllowed: allows --force-with-lease', () => {
  assert.doesNotThrow(() => assertGitAllowed(['push', '--force-with-lease']));
  assert.doesNotThrow(() => assertGitAllowed(['push', '--force-with-lease=br']));
  // Lease wins even if a bare --force token is also present.
  assert.doesNotThrow(() => assertGitAllowed(['push', '--force-with-lease', '--force']));
});

test('assertGitAllowed: allows ordinary pushes', () => {
  assert.doesNotThrow(() => assertGitAllowed(['push']));
  assert.doesNotThrow(() => assertGitAllowed(['push', '-u', 'origin', 'feature/x']));
});

test('assertGitAllowed: the rule keys off the push subcommand, not the --force token', () => {
  // `git worktree remove --force` and `git clean --force` must not be flagged.
  assert.doesNotThrow(() => assertGitAllowed(['worktree', 'remove', '--force', '/tmp/wt']));
  assert.doesNotThrow(() => assertGitAllowed(['clean', '-f']));
  assert.doesNotThrow(() => assertGitAllowed(['worktree', 'add', '/tmp/wt', '-b', 'br', 'main']));
});

test('runGit: rejects a force-push before spawning git', async () => {
  await assert.rejects(() => runGit(['push', '--force']), GitGuardError);
});

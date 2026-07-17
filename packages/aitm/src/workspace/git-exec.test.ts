import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGitAllowed, GitGuardError, runGit } from './git-exec.ts';

test('assertGitAllowed: rejects plain force-push', () => {
  assert.throws(() => assertGitAllowed(['push', '--force']), GitGuardError);
  assert.throws(() => assertGitAllowed(['push', '-f']), GitGuardError);
  assert.throws(() => assertGitAllowed(['push', '--force=origin']), GitGuardError);
  assert.throws(() => assertGitAllowed(['push', '-u', 'origin', 'br', '--force']), GitGuardError);
});

test('assertGitAllowed: rejects --force even alongside --force-with-lease', () => {
  // A trailing --force overrides the lease in git, so this is really a plain force-push.
  assert.throws(() => assertGitAllowed(['push', '--force-with-lease', '--force']), GitGuardError);
});

test('assertGitAllowed: rejects a leading-+ force refspec (plain force, always)', () => {
  // `git push origin +main` / `+src:dst` is git's plain-force form — rejected even by default.
  assert.throws(() => assertGitAllowed(['push', 'origin', '+main']), GitGuardError);
  assert.throws(
    () => assertGitAllowed(['push', 'origin', '+refs/heads/x:refs/heads/x']),
    GitGuardError,
  );
});

test('assertGitAllowed: allows --force-with-lease on its own', () => {
  assert.doesNotThrow(() => assertGitAllowed(['push', '--force-with-lease']));
  assert.doesNotThrow(() => assertGitAllowed(['push', '--force-with-lease=br']));
});

test('assertGitAllowed: allowForcePush=false rejects --force-with-lease too', () => {
  assert.throws(
    () => assertGitAllowed(['push', '--force-with-lease'], { allowForcePush: false }),
    GitGuardError,
  );
  assert.throws(
    () => assertGitAllowed(['push', '--force-with-lease=br'], { allowForcePush: false }),
    GitGuardError,
  );
  // Default / explicit-true policy still permits it.
  assert.doesNotThrow(() =>
    assertGitAllowed(['push', '--force-with-lease'], { allowForcePush: true }),
  );
  assert.doesNotThrow(() => assertGitAllowed(['push', '--force-with-lease']));
});

test('assertGitAllowed: allowForcePush=false leaves ordinary pushes alone', () => {
  assert.doesNotThrow(() =>
    assertGitAllowed(['push', '-u', 'origin', 'x'], { allowForcePush: false }),
  );
});

test('assertGitAllowed: allows ordinary pushes', () => {
  assert.doesNotThrow(() => assertGitAllowed(['push']));
  assert.doesNotThrow(() => assertGitAllowed(['push', '-u', 'origin', 'feature/x']));
});

test('assertGitAllowed: the rule keys off the push subcommand, not the --force token', () => {
  // `git checkout --force` and `git clean --force` must not be flagged.
  assert.doesNotThrow(() => assertGitAllowed(['checkout', '--force', 'br']));
  assert.doesNotThrow(() => assertGitAllowed(['clean', '-f']));
  assert.doesNotThrow(() => assertGitAllowed(['checkout', '-B', 'br', 'main']));
});

test('runGit: rejects a force-push before spawning git', async () => {
  await assert.rejects(() => runGit(['push', '--force']), GitGuardError);
});

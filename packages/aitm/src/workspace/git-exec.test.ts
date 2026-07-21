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

test('commitsAheadOfBase: 0 on a fresh branch, counts new commits, null when unmeasurable', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execa } = await import('execa');
  const { commitsAheadOfBase } = await import('./git-exec.ts');

  const repo = await mkdtemp(join(tmpdir(), 'aitm-ahead-'));
  const remote = await mkdtemp(join(tmpdir(), 'aitm-ahead-origin-'));
  try {
    await execa('git', ['init', '--initial-branch=main', repo]);
    await execa('git', ['config', 'user.email', 'test@aitm.local'], { cwd: repo });
    await execa('git', ['config', 'user.name', 'aitm test'], { cwd: repo });
    await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    await execa('git', ['init', '--bare', '--initial-branch=main', remote]);
    await execa('git', ['remote', 'add', 'origin', remote], { cwd: repo });
    await execa('git', ['push', 'origin', 'main'], { cwd: repo });

    await execa('git', ['checkout', '-B', 'feature/x'], { cwd: repo });
    assert.equal(await commitsAheadOfBase(repo, 'main', 'feature/x'), 0);

    await writeFile(join(repo, 'a.txt'), 'a\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo });
    await execa('git', ['commit', '-m', 'add a'], { cwd: repo });
    assert.equal(await commitsAheadOfBase(repo, 'main', 'feature/x'), 1);

    // Unmeasurable (unknown base ref) must be null — never a false "empty branch".
    assert.equal(await commitsAheadOfBase(repo, 'no-such-base', 'feature/x'), null);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

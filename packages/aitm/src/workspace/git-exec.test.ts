import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertGitAllowed,
  DEFAULT_GIT_TIMEOUT_MS,
  execaOptions,
  GitGuardError,
  runGit,
} from './git-exec.ts';

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

test('assertGitAllowed: finds the push subcommand behind leading global options', () => {
  assert.throws(() => assertGitAllowed(['-C', '/tmp/repo', 'push', '--force']), GitGuardError);
  assert.throws(() => assertGitAllowed(['-c', 'k=v', 'push', '-f']), GitGuardError);
  assert.throws(
    () => assertGitAllowed(['--git-dir=/tmp/repo/.git', 'push', '--force']),
    GitGuardError,
  );
  assert.throws(
    () => assertGitAllowed(['--no-optional-locks', 'push', 'origin', '+main']),
    GitGuardError,
  );
  assert.throws(
    () => assertGitAllowed(['-C', '/tmp/repo', '-c', 'k=v', '-p', 'push', '--force']),
    GitGuardError,
  );
  assert.throws(
    () => assertGitAllowed(['--work-tree', '/tmp/repo', '--namespace', 'ns', 'push', '--force']),
    GitGuardError,
  );
});

test('assertGitAllowed: policy applies behind leading global options', () => {
  assert.throws(
    () =>
      assertGitAllowed(['-C', '/tmp/repo', 'push', '--force-with-lease'], {
        allowForcePush: false,
      }),
    GitGuardError,
  );
  assert.doesNotThrow(() => assertGitAllowed(['-C', '/tmp/repo', 'push', '--force-with-lease']));
  assert.doesNotThrow(() => assertGitAllowed(['-c', 'k=v', 'push', '-u', 'origin', 'feature/x']));
});

test('assertGitAllowed: a global option value is not read as the subcommand or a force token', () => {
  // A directory literally named `push` is not a push; a `+`/`--force` VALUE is not a force-push.
  assert.doesNotThrow(() => assertGitAllowed(['-C', 'push', 'status', '--porcelain']));
  assert.doesNotThrow(() => assertGitAllowed(['-C', '+weird-dir', 'status']));
  assert.doesNotThrow(() => assertGitAllowed(['-c', 'user.name=--force', 'status']));
  // …but the real subcommand behind it is still guarded.
  assert.throws(() => assertGitAllowed(['-C', 'push', 'push', '--force']), GitGuardError);
});

test('assertGitAllowed: refuses an unrecognized leading option instead of guessing', () => {
  assert.throws(() => assertGitAllowed(['--not-a-git-option', 'push', '--force']), GitGuardError);
  // git itself rejects the attached forms (`-C<dir>`, `-c<k>=<v>`); the guard will not guess either.
  assert.throws(() => assertGitAllowed(['-C/tmp/repo', 'push', '--force']), GitGuardError);
  assert.throws(() => assertGitAllowed(['-ck=v', 'push', '-f']), GitGuardError);
});

test('assertGitAllowed: refuses an inline alias definition', () => {
  // `git -c alias.p='push --force' p` force-pushes behind a subcommand the guard cannot follow.
  assert.throws(() => assertGitAllowed(['-c', 'alias.p=push --force', 'p']), GitGuardError);
  assert.throws(() => assertGitAllowed(['-c', 'ALIAS.p=push --force', 'p']), GitGuardError);
  assert.throws(() => assertGitAllowed(['--config-env', 'alias.p=VAR', 'p']), GitGuardError);
  assert.throws(() => assertGitAllowed(['--config-env=alias.p=VAR', 'p']), GitGuardError);
  // Ordinary `-c` settings stay allowed.
  assert.doesNotThrow(() => assertGitAllowed(['-c', 'core.editor=true', 'rebase', '--continue']));
});

test('assertGitAllowed: allows a global-option-only invocation with no subcommand', () => {
  assert.doesNotThrow(() => assertGitAllowed([]));
  assert.doesNotThrow(() => assertGitAllowed(['--version']));
  assert.doesNotThrow(() => assertGitAllowed(['-C', '/tmp/repo']));
});

test('runGit: rejects a force-push before spawning git', async () => {
  await assert.rejects(() => runGit(['push', '--force']), GitGuardError);
  await assert.rejects(() => runGit(['-C', '/tmp', 'push', '--force']), GitGuardError);
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

// Nothing else bounds a git child: a stalled connection to a remote leaves `fetch`/`push`/`ls-remote`
// waiting forever, and a SIGINT can only kill an in-flight child that was given the run's signal.
test('execaOptions: no options → the default deadline, nothing else', () => {
  assert.deepEqual(execaOptions(), { timeout: DEFAULT_GIT_TIMEOUT_MS });
});

test('execaOptions: cwd + explicit timeout + signal → execa cwd/timeout/cancelSignal', () => {
  const controller = new AbortController();
  assert.deepEqual(execaOptions({ cwd: '/tmp/repo', timeout: 25, signal: controller.signal }), {
    cwd: '/tmp/repo',
    timeout: 25,
    cancelSignal: controller.signal,
  });
});

test('execaOptions: the git policy is not passed to execa', () => {
  // allowForcePush governs assertGitAllowed, not the subprocess — leaking it would be an unknown
  // execa option.
  assert.deepEqual(execaOptions({ cwd: '/tmp/repo', allowForcePush: false }), {
    cwd: '/tmp/repo',
    timeout: DEFAULT_GIT_TIMEOUT_MS,
  });
});

test('runGit: an already-aborted signal kills the child rather than running it to completion', async () => {
  // Proves the option actually reaches execa, not just the option builder.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runGit(['--version'], { signal: controller.signal }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /cancel|terminat/i);
      return true;
    },
  );
});

test('runGit: a child that outruns its deadline is killed', async () => {
  // `git --paginate log` on a repo it cannot read still exits fast, so drive the deadline with a
  // subcommand that waits on stdin: `git hash-object --stdin` reads until EOF, which never comes.
  await assert.rejects(
    () => runGit(['hash-object', '--stdin'], { timeout: 200 }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/i);
      return true;
    },
  );
});

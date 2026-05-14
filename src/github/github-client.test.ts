import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed, GhAuthRequired, MergeConflict, PrNotFound } from './errors.ts';
import { DEFAULT_PR_LABEL, GitHubClient, type RunCmd, type RunCmdResult } from './github-client.ts';

type Call = { file: string; args: string[]; cwd?: string };

type Reply = Partial<RunCmdResult> & { exitCode?: number };

function makeRun(replies: Reply[] | ((call: Call, idx: number) => Reply)): {
  run: RunCmd;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: RunCmd = async (file, args, options) => {
    const call: Call = { file, args: [...args], ...(options?.cwd ? { cwd: options.cwd } : {}) };
    calls.push(call);
    const reply =
      typeof replies === 'function' ? replies(call, calls.length - 1) : replies[calls.length - 1];
    return {
      stdout: reply?.stdout ?? '',
      stderr: reply?.stderr ?? '',
      exitCode: reply?.exitCode ?? 0,
    };
  };
  return { run, calls };
}

test('GitHubClient is constructible (skeleton)', () => {
  const g = new GitHubClient('/tmp/repo');
  assert.ok(g instanceof GitHubClient);
});

test('domain errors carry their name', () => {
  assert.equal(new PrNotFound().name, 'PrNotFound');
  assert.equal(new GhAuthRequired().name, 'GhAuthRequired');
  assert.equal(new CiFailed().name, 'CiFailed');
  assert.equal(new MergeConflict().name, 'MergeConflict');
});

test('currentBranch shells git rev-parse with cwd', async () => {
  const { run, calls } = makeRun([{ stdout: 'feature/foo\n' }]);
  const g = new GitHubClient('/tmp/repo', run);
  const branch = await g.currentBranch();
  assert.equal(branch, 'feature/foo');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    file: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd: '/tmp/repo',
  });
});

test('currentBranch throws on non-zero exit', async () => {
  const { run } = makeRun([{ exitCode: 128, stderr: 'fatal: not a git repository' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.currentBranch(), /git rev-parse failed/);
});

test('defaultBranch shells gh repo view and parses JSON', async () => {
  const { run, calls } = makeRun([
    { stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }) },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  const branch = await g.defaultBranch();
  assert.equal(branch, 'main');
  assert.deepEqual(calls[0]?.args, ['repo', 'view', '--json', 'defaultBranchRef']);
  assert.equal(calls[0]?.file, 'gh');
});

test('defaultBranch throws on unexpected JSON shape', async () => {
  const { run } = makeRun([{ stdout: JSON.stringify({ wrong: 'shape' }) }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.defaultBranch(), /unexpected JSON shape/);
});

test('getPrForBranch passes branch + json fields and parses result', async () => {
  const pr = {
    number: 42,
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/42',
    headRefName: 'feature/foo',
    baseRefName: 'main',
  };
  const { run, calls } = makeRun([{ stdout: JSON.stringify(pr) }]);
  const g = new GitHubClient('/tmp/repo', run);
  const result = await g.getPrForBranch('feature/foo');
  assert.deepEqual(result, pr);
  assert.deepEqual(calls[0]?.args, [
    'pr',
    'view',
    'feature/foo',
    '--json',
    'number,state,url,headRefName,baseRefName',
  ]);
});

test('getPrForBranch returns null when gh reports no PR', async () => {
  const { run } = makeRun([
    { exitCode: 1, stderr: 'no pull requests found for branch feature/foo\n' },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  const result = await g.getPrForBranch('feature/foo');
  assert.equal(result, null);
});

test('getPrForBranch surfaces unrelated errors', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'HTTP 500: server is down' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.getPrForBranch('feature/foo'), /gh pr view failed/);
});

test('createPr passes title/body/base/head and default label, then refetches', async () => {
  const pr = {
    number: 7,
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/7',
    headRefName: 'feature/bar',
    baseRefName: 'main',
  };
  const { run, calls } = makeRun([
    { stdout: 'https://github.com/org/repo/pull/7\n' },
    { stdout: JSON.stringify(pr) },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  const result = await g.createPr({
    title: 'feat: bar',
    body: 'body text',
    base: 'main',
    head: 'feature/bar',
  });
  assert.deepEqual(result, pr);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.args, [
    'pr',
    'create',
    '--title',
    'feat: bar',
    '--body',
    'body text',
    '--base',
    'main',
    '--head',
    'feature/bar',
    '--label',
    DEFAULT_PR_LABEL,
  ]);
  assert.deepEqual(calls[1]?.args.slice(0, 3), ['pr', 'view', 'feature/bar']);
});

test('createPr appends --draft and custom labels', async () => {
  const pr = {
    number: 8,
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/8',
    headRefName: 'feature/baz',
    baseRefName: 'main',
  };
  const { run, calls } = makeRun([{ stdout: 'url' }, { stdout: JSON.stringify(pr) }]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.createPr({
    title: 't',
    body: 'b',
    base: 'main',
    head: 'feature/baz',
    draft: true,
    labels: ['l1', 'l2'],
  });
  const args = calls[0]?.args ?? [];
  assert.ok(args.includes('--draft'));
  const labelIdx: number[] = [];
  args.forEach((v, i) => {
    if (v === '--label') labelIdx.push(i);
  });
  assert.equal(labelIdx.length, 2);
  assert.equal(args[(labelIdx[0] ?? 0) + 1], 'l1');
  assert.equal(args[(labelIdx[1] ?? 0) + 1], 'l2');
  assert.ok(!args.includes(DEFAULT_PR_LABEL));
});

test('createPr throws if create fails', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'a label by that name already exists' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(
    () =>
      g.createPr({
        title: 't',
        body: 'b',
        base: 'main',
        head: 'h',
      }),
    /gh pr create failed/,
  );
});

test('mergePr passes pr number and method flag', async () => {
  const { run, calls } = makeRun([{ stdout: 'merged' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.mergePr(123, 'squash');
  assert.deepEqual(calls[0]?.args, ['pr', 'merge', '123', '--squash']);
});

test('mergePr supports rebase and merge methods', async () => {
  const { run, calls } = makeRun([{ stdout: '' }, { stdout: '' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.mergePr(1, 'rebase');
  await g.mergePr(2, 'merge');
  assert.equal(calls[0]?.args[3], '--rebase');
  assert.equal(calls[1]?.args[3], '--merge');
});

test('mergePr throws MergeConflict on conflict stderr signal', async () => {
  const { run } = makeRun([
    {
      exitCode: 1,
      stderr:
        'failed to merge: pull request is not mergeable: the merge commit cannot be cleanly created',
    },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.mergePr(9, 'squash'), MergeConflict);
});

test('mergePr surfaces non-conflict failures generically', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'HTTP 403: forbidden' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.mergePr(9, 'squash'), /gh pr merge failed/);
});

test('authStatus parses scopes from gh stderr', async () => {
  const stderr = [
    'github.com',
    '  ✓ Logged in to github.com as sebyx07 (oauth_token)',
    "  - Token scopes: 'repo', 'read:org', 'workflow'",
  ].join('\n');
  const { run, calls } = makeRun([{ stderr, exitCode: 0 }]);
  const g = new GitHubClient('/tmp/repo', run);
  const result = await g.authStatus();
  assert.equal(result.ok, true);
  assert.deepEqual(result.scopes, ['repo', 'read:org', 'workflow']);
  assert.deepEqual(calls[0]?.args, ['auth', 'status', '--hostname', 'github.com']);
});

test('authStatus reports not-ok on non-zero exit, scopes empty when absent', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'You are not logged into github.com' }]);
  const g = new GitHubClient('/tmp/repo', run);
  const result = await g.authStatus();
  assert.equal(result.ok, false);
  assert.deepEqual(result.scopes, []);
});

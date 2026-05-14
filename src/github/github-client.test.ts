import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed, GhAuthRequired, MergeConflict, PrNotFound } from './errors.ts';
import {
  CHECKS_INITIAL_DELAY_MS,
  CHECKS_MAX_DELAY_MS,
  DEFAULT_PR_LABEL,
  GitHubClient,
  type RunCmd,
  type RunCmdResult,
  type Sleep,
} from './github-client.ts';

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

function makeSleep(): { sleep: Sleep; delays: number[] } {
  const delays: number[] = [];
  const sleep: Sleep = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

function findFieldValue(args: readonly string[], flag: '-f' | '-F', key: string): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) {
      const kv = args[i + 1];
      if (typeof kv === 'string' && kv.startsWith(`${key}=`)) return kv.slice(key.length + 1);
    }
  }
  return null;
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

test('waitForChecks returns success when all checks pass', async () => {
  const { run, calls } = makeRun([
    {
      stdout: JSON.stringify([
        { bucket: 'pass', name: 'lint', state: 'SUCCESS' },
        { bucket: 'pass', name: 'test', state: 'SUCCESS' },
        { bucket: 'skipping', name: 'release', state: 'NEUTRAL' },
      ]),
    },
  ]);
  const { sleep, delays } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  const status = await g.waitForChecks(42);
  assert.equal(status, 'success');
  assert.deepEqual(calls[0]?.args, ['pr', 'checks', '42', '--json', 'bucket,name,state']);
  assert.equal(delays.length, 0);
});

test('waitForChecks returns success when there are no checks at all', async () => {
  const { run } = makeRun([{ stdout: '[]' }]);
  const { sleep } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  assert.equal(await g.waitForChecks(1), 'success');
});

test('waitForChecks polls while pending with 1s→2s→4s backoff (60s cap)', async () => {
  const pending = JSON.stringify([{ bucket: 'pending', name: 'test', state: 'IN_PROGRESS' }]);
  const passing = JSON.stringify([{ bucket: 'pass', name: 'test', state: 'SUCCESS' }]);
  const { run, calls } = makeRun([
    { stdout: pending },
    { stdout: pending },
    { stdout: pending },
    { stdout: passing },
  ]);
  const { sleep, delays } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  const status = await g.waitForChecks(7);
  assert.equal(status, 'success');
  assert.equal(calls.length, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test('waitForChecks caps backoff at CHECKS_MAX_DELAY_MS', async () => {
  // 7 pending replies before success → delays: 1, 2, 4, 8, 16, 32, 60 (capped).
  const pending = JSON.stringify([{ bucket: 'pending', name: 'slow', state: 'QUEUED' }]);
  const passing = JSON.stringify([{ bucket: 'pass', name: 'slow', state: 'SUCCESS' }]);
  const replies: Reply[] = Array.from({ length: 7 }, () => ({ stdout: pending }));
  replies.push({ stdout: passing });
  const { run } = makeRun(replies);
  const { sleep, delays } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  await g.waitForChecks(1);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000, 32_000, CHECKS_MAX_DELAY_MS]);
  assert.equal(CHECKS_INITIAL_DELAY_MS, 1000);
});

test('waitForChecks throws CiFailed on any failure bucket', async () => {
  const { run } = makeRun([
    {
      stdout: JSON.stringify([
        { bucket: 'pass', name: 'lint', state: 'SUCCESS' },
        { bucket: 'fail', name: 'test', state: 'FAILURE' },
      ]),
      exitCode: 8,
    },
  ]);
  const { sleep, delays } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  await assert.rejects(
    () => g.waitForChecks(99),
    (err) => err instanceof CiFailed && /test=fail/.test(err.message),
  );
  assert.equal(delays.length, 0);
});

test('waitForChecks throws CiFailed on cancelled bucket', async () => {
  const { run } = makeRun([
    { stdout: JSON.stringify([{ bucket: 'cancel', name: 'test', state: 'CANCELLED' }]) },
  ]);
  const { sleep } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  await assert.rejects(() => g.waitForChecks(99), CiFailed);
});

test('waitForChecks throws on unparseable stdout', async () => {
  const { run } = makeRun([{ exitCode: 1, stdout: '', stderr: 'auth required' }]);
  const { sleep } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  await assert.rejects(() => g.waitForChecks(1), /gh pr checks failed/);
});

type GqlThread = {
  id: string;
  isResolved: boolean;
  path: string | null;
  comments: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ id: string; body: string; author: { login: string } | null }>;
  };
};

function threadsResponse(
  nodes: GqlThread[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
): string {
  return JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } },
  });
}

function commentsResponse(
  nodes: Array<{ id: string; body: string; author: { login: string } | null }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
): string {
  return JSON.stringify({ data: { node: { comments: { pageInfo, nodes } } } });
}

test('listUnresolvedThreads fetches repo meta then GraphQL with owner/repo/pr variables', async () => {
  const meta = JSON.stringify({ owner: { login: 'org' }, name: 'repo' });
  const gql = threadsResponse([
    {
      id: 'PRRT_1',
      isResolved: false,
      path: 'src/foo.ts',
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: 'IC_1', body: 'please fix', author: { login: 'reviewer' } }],
      },
    },
    {
      id: 'PRRT_2',
      isResolved: true,
      path: 'src/bar.ts',
      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    },
    {
      id: 'PRRT_3',
      isResolved: false,
      path: null,
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: 'IC_2', body: 'general', author: null }],
      },
    },
  ]);
  const { run, calls } = makeRun([{ stdout: meta }, { stdout: gql }]);
  const g = new GitHubClient('/tmp/repo', run);
  const threads = await g.listUnresolvedThreads(42);

  assert.equal(threads.length, 2);
  assert.equal(threads[0]?.id, 'PRRT_1');
  assert.equal(threads[0]?.isResolved, false);
  assert.equal(threads[0]?.path, 'src/foo.ts');
  assert.deepEqual(threads[0]?.comments, [{ id: 'IC_1', body: 'please fix', author: 'reviewer' }]);
  assert.equal(threads[1]?.id, 'PRRT_3');
  assert.equal(threads[1]?.path, null);
  assert.equal(threads[1]?.comments[0]?.author, 'ghost');

  assert.deepEqual(calls[0]?.args, ['repo', 'view', '--json', 'owner,name']);
  const gqlArgs = calls[1]?.args ?? [];
  assert.equal(calls[1]?.file, 'gh');
  assert.equal(gqlArgs[0], 'api');
  assert.equal(gqlArgs[1], 'graphql');
  assert.equal(findFieldValue(gqlArgs, '-f', 'owner'), 'org');
  assert.equal(findFieldValue(gqlArgs, '-f', 'repo'), 'repo');
  assert.equal(findFieldValue(gqlArgs, '-F', 'pr'), '42');
  // No cursor on the first page.
  assert.equal(findFieldValue(gqlArgs, '-f', 'threadsCursor'), null);
  const query = findFieldValue(gqlArgs, '-f', 'query');
  assert.ok(query?.includes('reviewThreads(first: 100, after: $threadsCursor)'));
  assert.ok(query?.includes('pageInfo { hasNextPage endCursor }'));
  assert.ok(query?.includes('pullRequest(number: $pr)'));
  assert.ok(query?.includes('repository(owner: $owner, name: $repo)'));
});

test('listUnresolvedThreads pages through reviewThreads with endCursor', async () => {
  const meta = JSON.stringify({ owner: { login: 'org' }, name: 'repo' });
  const page1 = threadsResponse(
    [
      {
        id: 'PRRT_1',
        isResolved: false,
        path: 'a.ts',
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: 'IC_1', body: 'x', author: { login: 'r' } }],
        },
      },
    ],
    { hasNextPage: true, endCursor: 'cursor-1' },
  );
  const page2 = threadsResponse([
    {
      id: 'PRRT_2',
      isResolved: false,
      path: 'b.ts',
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ id: 'IC_2', body: 'y', author: { login: 'r' } }],
      },
    },
  ]);
  const { run, calls } = makeRun([{ stdout: meta }, { stdout: page1 }, { stdout: page2 }]);
  const g = new GitHubClient('/tmp/repo', run);
  const threads = await g.listUnresolvedThreads(7);

  assert.equal(threads.length, 2);
  assert.equal(threads[0]?.id, 'PRRT_1');
  assert.equal(threads[1]?.id, 'PRRT_2');
  // Second page sends the cursor returned by the first page.
  assert.equal(findFieldValue(calls[2]?.args ?? [], '-f', 'threadsCursor'), 'cursor-1');
});

test('listUnresolvedThreads pages through nested comments for unresolved threads only', async () => {
  const meta = JSON.stringify({ owner: { login: 'org' }, name: 'repo' });
  const gql = threadsResponse([
    {
      id: 'PRRT_long',
      isResolved: false,
      path: 'big.ts',
      comments: {
        pageInfo: { hasNextPage: true, endCursor: 'c-1' },
        nodes: [{ id: 'IC_a', body: 'first', author: { login: 'r' } }],
      },
    },
    {
      // Resolved threads must NOT trigger extra paginated fetches.
      id: 'PRRT_resolved',
      isResolved: true,
      path: 'x.ts',
      comments: {
        pageInfo: { hasNextPage: true, endCursor: 'should-not-fetch' },
        nodes: [{ id: 'IC_z', body: 'old', author: { login: 'r' } }],
      },
    },
  ]);
  const morePage1 = commentsResponse([{ id: 'IC_b', body: 'second', author: { login: 'r' } }], {
    hasNextPage: true,
    endCursor: 'c-2',
  });
  const morePage2 = commentsResponse([{ id: 'IC_c', body: 'third', author: null }]);
  const { run, calls } = makeRun([
    { stdout: meta },
    { stdout: gql },
    { stdout: morePage1 },
    { stdout: morePage2 },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  const threads = await g.listUnresolvedThreads(3);

  assert.equal(threads.length, 1);
  assert.deepEqual(
    threads[0]?.comments.map((c) => c.id),
    ['IC_a', 'IC_b', 'IC_c'],
  );
  // Two follow-up calls, both for the unresolved thread, with cursors c-1 then c-2.
  assert.equal(calls.length, 4);
  assert.equal(findFieldValue(calls[2]?.args ?? [], '-f', 'threadId'), 'PRRT_long');
  assert.equal(findFieldValue(calls[2]?.args ?? [], '-f', 'commentsCursor'), 'c-1');
  assert.equal(findFieldValue(calls[3]?.args ?? [], '-f', 'commentsCursor'), 'c-2');
  const commentsQuery = findFieldValue(calls[2]?.args ?? [], '-f', 'query');
  assert.ok(commentsQuery?.includes('PullRequestReviewThread'));
  assert.ok(commentsQuery?.includes('comments(first: 100, after: $commentsCursor)'));
  // The third comment had `author: null` → maps to 'ghost'.
  assert.equal(threads[0]?.comments[2]?.author, 'ghost');
});

test('listUnresolvedThreads throws when GraphQL call fails', async () => {
  const meta = JSON.stringify({ owner: { login: 'org' }, name: 'repo' });
  const { run } = makeRun([{ stdout: meta }, { exitCode: 1, stderr: 'GraphQL: not found' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.listUnresolvedThreads(1), /gh api graphql \(reviewThreads\) failed/);
});

test('listUnresolvedThreads surfaces threadComments failures distinctly', async () => {
  const meta = JSON.stringify({ owner: { login: 'org' }, name: 'repo' });
  const gql = threadsResponse([
    {
      id: 'PRRT_1',
      isResolved: false,
      path: 'a.ts',
      comments: {
        pageInfo: { hasNextPage: true, endCursor: 'c-1' },
        nodes: [{ id: 'IC_1', body: 'x', author: { login: 'r' } }],
      },
    },
  ]);
  const { run } = makeRun([
    { stdout: meta },
    { stdout: gql },
    { exitCode: 1, stderr: 'GraphQL: rate limited' },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(
    () => g.listUnresolvedThreads(1),
    /gh api graphql \(threadComments\) failed/,
  );
});

test('replyToThread sends mutation with threadId + body variables', async () => {
  const { run, calls } = makeRun([{ stdout: '{"data":{"addPullRequestReviewThreadReply":{}}}' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.replyToThread('PRRT_abc', 'thanks for the catch');
  const args = calls[0]?.args ?? [];
  assert.equal(calls[0]?.file, 'gh');
  assert.equal(args[0], 'api');
  assert.equal(args[1], 'graphql');
  assert.equal(findFieldValue(args, '-f', 'threadId'), 'PRRT_abc');
  assert.equal(findFieldValue(args, '-f', 'body'), 'thanks for the catch');
  const query = findFieldValue(args, '-f', 'query');
  assert.ok(query?.includes('addPullRequestReviewThreadReply'));
  assert.ok(query?.includes('pullRequestReviewThreadId: $threadId'));
  assert.ok(query?.includes('body: $body'));
});

test('replyToThread throws on non-zero exit', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'GraphQL: thread is locked' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(
    () => g.replyToThread('PRRT_x', 'hi'),
    /gh api graphql \(replyToThread\) failed/,
  );
});

test('resolveThread sends mutation with threadId variable', async () => {
  const { run, calls } = makeRun([
    { stdout: '{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_x","isResolved":true}}}}' },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.resolveThread('PRRT_x');
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], 'api');
  assert.equal(args[1], 'graphql');
  assert.equal(findFieldValue(args, '-f', 'threadId'), 'PRRT_x');
  const query = findFieldValue(args, '-f', 'query');
  assert.ok(query?.includes('resolveReviewThread'));
  assert.ok(query?.includes('threadId: $threadId'));
});

test('resolveThread throws on non-zero exit', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'GraphQL: not authorized' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.resolveThread('PRRT_x'), /gh api graphql \(resolveThread\) failed/);
});

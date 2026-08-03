import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GhCliMissing, GhCommandFailed, MergeConflict } from './errors.ts';
import {
  CHECKS_START_WAIT_MS,
  DEFAULT_CMD_TIMEOUT_MS,
  DEFAULT_PR_LABEL,
  defaultRunCmd,
  defaultSleep,
  execaOptions,
  FAILED_RUN_LIST_LIMIT,
  GitHubClient,
  isInstantSleepEnabled,
  type RunCmd,
  type RunCmdOptions,
  type RunCmdResult,
  type Sleep,
  withSignal,
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
    const idx = calls.length - 1;
    const reply = typeof replies === 'function' ? replies(call, idx) : replies[idx];
    if (!reply) {
      throw new Error(`No mocked reply for call #${idx}: ${file} ${args.join(' ')}`);
    }
    return {
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode ?? 0,
    };
  };
  return { run, calls };
}

function makeSleep(onSleep?: (ms: number) => void): {
  sleep: Sleep;
  delays: number[];
  signals: Array<AbortSignal | undefined>;
} {
  const delays: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const sleep: Sleep = async (ms, signal) => {
    delays.push(ms);
    signals.push(signal);
    onSleep?.(ms);
  };
  return { sleep, delays, signals };
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

test('defaultBranch caches the branch (one subprocess across calls)', async () => {
  const { run, calls } = makeRun([
    { stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }) },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  assert.equal(await g.defaultBranch(), 'main');
  assert.equal(await g.defaultBranch(), 'main');
  assert.equal(calls.length, 1, 'second lookup is served from cache');
});

test('defaultBranch throws on unexpected JSON shape', async () => {
  const { run } = makeRun([{ stdout: JSON.stringify({ wrong: 'shape' }) }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.defaultBranch(), GhCommandFailed);
});

test('defaultBranch: exit-0 non-JSON stdout throws naming the command, cause preserved', async () => {
  const { run } = makeRun([{ stdout: 'gh: a deprecation notice, not JSON', exitCode: 0 }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(
    () => g.defaultBranch(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gh repo view: unparseable JSON stdout/);
      assert.ok(err.cause instanceof SyntaxError, 'JSON.parse SyntaxError is preserved as cause');
      return true;
    },
  );
});

test('authenticatedLogin shells gh api user and returns the raw login', async () => {
  const { run, calls } = makeRun([{ stdout: 'aitm-bot\n' }]);
  const g = new GitHubClient('/tmp/repo', run);
  assert.equal(await g.authenticatedLogin(), 'aitm-bot');
  assert.deepEqual(calls[0]?.args, ['api', 'user', '--jq', '.login']);
  assert.equal(calls[0]?.file, 'gh');
  assert.equal(calls[0]?.cwd, '/tmp/repo');
});

test('authenticatedLogin caches the login (one subprocess across calls)', async () => {
  const { run, calls } = makeRun([{ stdout: 'aitm-bot\n' }]);
  const g = new GitHubClient('/tmp/repo', run);
  assert.equal(await g.authenticatedLogin(), 'aitm-bot');
  assert.equal(await g.authenticatedLogin(), 'aitm-bot');
  assert.equal(calls.length, 1, 'second lookup is served from cache');
});

test('authenticatedLogin throws when gh api user fails', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'gh: not logged in' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.authenticatedLogin(), /gh api user failed/);
});

test('authenticatedLogin throws on an empty login', async () => {
  const { run } = makeRun([{ stdout: '\n' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.authenticatedLogin(), /empty login/);
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

test('getPrForBranch: exit-0 non-JSON stdout throws naming the command, cause preserved', async () => {
  const { run } = makeRun([{ stdout: '<!DOCTYPE html>not json', exitCode: 0 }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(
    () => g.getPrForBranch('feature/foo'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gh pr view: unparseable JSON stdout/);
      assert.ok(err.cause instanceof SyntaxError, 'JSON.parse SyntaxError is preserved as cause');
      return true;
    },
  );
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
    { exitCode: 1, stderr: 'no pull requests found for branch feature/bar' }, // gh pr view (pre-check → none)
    { stdout: '' }, // gh label create <default> --force (idempotent ensure)
    { stdout: 'https://github.com/org/repo/pull/7\n' }, // gh pr create
    { stdout: JSON.stringify(pr) }, // gh pr view (refetch)
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  const result = await g.createPr({
    title: 'feat: bar',
    body: 'body text',
    base: 'main',
    head: 'feature/bar',
  });
  assert.deepEqual(result, pr);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0]?.args.slice(0, 3), ['pr', 'view', 'feature/bar']);
  assert.deepEqual(calls[1]?.args, ['label', 'create', DEFAULT_PR_LABEL, '--force']);
  assert.deepEqual(calls[2]?.args, [
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
  assert.deepEqual(calls[3]?.args.slice(0, 3), ['pr', 'view', 'feature/bar']);
});

test('createPr appends --draft and custom labels', async () => {
  const pr = {
    number: 8,
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/8',
    headRefName: 'feature/baz',
    baseRefName: 'main',
  };
  // pr view (pre-check → none) + 2 label-create calls (l1, l2) + pr create + pr view.
  const { run, calls } = makeRun([
    { exitCode: 1, stderr: 'no pull requests found for branch feature/baz' },
    { stdout: '' },
    { stdout: '' },
    { stdout: 'url' },
    { stdout: JSON.stringify(pr) },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.createPr({
    title: 't',
    body: 'b',
    base: 'main',
    head: 'feature/baz',
    draft: true,
    labels: ['l1', 'l2'],
  });
  // Each custom label is ensured first via `gh label create … --force`.
  assert.deepEqual(
    calls.filter((c) => c.args[0] === 'label').map((c) => c.args[2]),
    ['l1', 'l2'],
  );
  const args = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create')?.args ?? [];
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
  // call #0 = pr view pre-check (none), #1 = label-create (ignored), #2 = pr create (fails).
  const { run } = makeRun([
    { exitCode: 1, stderr: 'no pull requests found for branch h' },
    { stdout: '' },
    { exitCode: 1, stderr: 'pull request create failed: validation error' },
  ]);
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

test('createPr adopts an existing PR for the head instead of creating a duplicate', async () => {
  // Idempotent open: a kill between `gh pr create` and persisting the PR number resumes here with
  // the PR already on GitHub. createPr must adopt it — a single `gh pr view`, no create, no label
  // ensure — so the resumed group proceeds instead of failing the re-create.
  const pr = {
    number: 42,
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/42',
    headRefName: 'feature/dup',
    baseRefName: 'main',
  };
  const { run, calls } = makeRun([{ stdout: JSON.stringify(pr) }]);
  const g = new GitHubClient('/tmp/repo', run);
  const result = await g.createPr({
    title: 'feat: dup',
    body: 'body',
    base: 'main',
    head: 'feature/dup',
  });
  assert.deepEqual(result, pr);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args.slice(0, 3), ['pr', 'view', 'feature/dup']);
  assert.ok(!calls.some((c) => c.args[0] === 'label'));
  assert.ok(!calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create'));
});

test('mergePr passes pr number and method flag', async () => {
  const { run, calls } = makeRun([{ stdout: 'merged' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.mergePr(123, 'squash');
  assert.deepEqual(calls[0]?.args, ['pr', 'merge', '123', '--squash']);
});

test('mergePr appends --admin when admin option is set', async () => {
  const { run, calls } = makeRun([{ stdout: 'merged' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.mergePr(332, 'squash', { admin: true });
  assert.deepEqual(calls[0]?.args, ['pr', 'merge', '332', '--squash', '--admin']);
});

test('mergePr omits --admin by default and when admin is false', async () => {
  const { run, calls } = makeRun([{ stdout: '' }, { stdout: '' }]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.mergePr(1, 'squash');
  await g.mergePr(2, 'squash', { admin: false });
  assert.ok(!calls[0]?.args.includes('--admin'));
  assert.ok(!calls[1]?.args.includes('--admin'));
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
    // The failure-path state check: an unmerged (OPEN) PR, so the conflict verdict stands.
    { exitCode: 0, stdout: '{"state":"OPEN"}' },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.mergePr(9, 'squash'), MergeConflict);
});

test('mergePr surfaces non-conflict failures generically', async () => {
  const { run } = makeRun([
    { exitCode: 1, stderr: 'HTTP 403: forbidden' },
    { exitCode: 0, stdout: '{"state":"OPEN"}' },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(() => g.mergePr(9, 'squash'), /gh pr merge failed/);
});

test('mergePr is idempotent: an already-merged PR is success, not a failure (resume crash window)', async () => {
  // gh pr merge on an already-merged PR exits non-zero; the state query confirms MERGED, so the
  // desired end state is already true. This is the crash window between mergePr succeeding on GitHub
  // and state.json persisting 'merged', then a resume re-driving the merge stage.
  const { run, calls } = makeRun([
    { exitCode: 1, stderr: 'X Pull request #5 is not mergeable: it has already been merged' },
    { exitCode: 0, stdout: '{"state":"MERGED"}' },
  ]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.mergePr(5, 'squash'); // resolves, does not throw
  assert.equal(calls.length, 2, 'the merge attempt plus one state confirmation');
  assert.deepEqual(calls[1]?.args, ['pr', 'view', '5', '--json', 'state']);
});

test('mergePr does not swallow a real failure when the state query itself fails', async () => {
  // isMerged is best-effort: an unparseable/failed state query returns false, so a genuine merge
  // failure still surfaces rather than being silently treated as merged.
  const { run } = makeRun([
    { exitCode: 1, stderr: 'HTTP 500: server error' },
    { exitCode: 1, stderr: 'gh: could not resolve PR' },
  ]);
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

// The poll/backoff/tolerance policy itself is tested against `pollChecks` directly in
// checks-poller.test.ts. These confirm only that the GitHubClient method is a thin, correctly
// wired delegation to it (cwd/pr/sleep/now/signal all reach pollChecks).
test('waitForChecks delegates to pollChecks with the client cwd, sleep, and pr', async () => {
  const { run, calls } = makeRun([
    { stdout: JSON.stringify([{ bucket: 'pass', name: 'test', state: 'SUCCESS' }]) },
  ]);
  const { sleep, delays } = makeSleep();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  const result = await g.waitForChecks(42);
  assert.equal(result.state, 'success');
  assert.deepEqual(calls[0]?.args, [
    'pr',
    'checks',
    '42',
    '--json',
    'bucket,name,state,description',
  ]);
  assert.equal(calls[0]?.cwd, '/tmp/repo');
  assert.deepEqual(delays, [CHECKS_START_WAIT_MS]);
});

test('waitForChecks: an already-aborted signal → pending, no gh call at all', async () => {
  const { run, calls } = makeRun(() => ({ stdout: '[]' }));
  const { sleep } = makeSleep();
  const controller = new AbortController();
  controller.abort();
  const g = new GitHubClient('/tmp/repo', run, sleep);
  const result = await g.waitForChecks(1, controller.signal);
  assert.equal(result.state, 'pending');
  assert.equal(calls.length, 0, 'a cancelled wait spawns no `gh pr checks`');
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

test('repoMeta is cached across calls (one gh repo view subprocess for two lookups)', async () => {
  const meta = JSON.stringify({ owner: { login: 'org' }, name: 'repo' });
  const gql1 = threadsResponse([]);
  const gql2 = threadsResponse([]);
  const { run, calls } = makeRun([{ stdout: meta }, { stdout: gql1 }, { stdout: gql2 }]);
  const g = new GitHubClient('/tmp/repo', run);
  await g.listUnresolvedThreads(1);
  await g.listUnresolvedThreads(2);

  const repoViewCalls = calls.filter(
    (c) => c.file === 'gh' && c.args[0] === 'repo' && c.args[1] === 'view',
  );
  assert.equal(repoViewCalls.length, 1, 'second listUnresolvedThreads reuses the cached repoMeta');
  assert.equal(calls.length, 3, 'only repo view + 2 GraphQL calls, no second repo view');
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

test('listUnresolvedThreads: exit-0 non-JSON repo view stdout throws naming the command, cause preserved', async () => {
  // repoMeta runs first; its parse must surface the offending command, not a bare SyntaxError.
  const { run } = makeRun([{ stdout: 'error: something went wrong', exitCode: 0 }]);
  const g = new GitHubClient('/tmp/repo', run);
  await assert.rejects(
    () => g.listUnresolvedThreads(1),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gh repo view: unparseable JSON stdout/);
      assert.ok(err.cause instanceof SyntaxError, 'JSON.parse SyntaxError is preserved as cause');
      return true;
    },
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

test('getFailedCiLogs downloads full logs for failed jobs of the PR head run', async () => {
  // Sequence: pr view → run list → repo view (repoMeta) → api jobs → api job logs.
  let runListArgs: string[] = [];
  const run: RunCmd = async (file, args) => {
    const a = args.join(' ');
    if (file === 'gh' && a.startsWith('pr view')) {
      return { stdout: '{"headRefName":"feat/x","headRefOid":"abc123"}', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && a.startsWith('run list')) {
      runListArgs = [...args];
      return {
        stdout: JSON.stringify([
          { databaseId: 111, headSha: 'abc123', conclusion: 'failure' },
          { databaseId: 222, headSha: 'old', conclusion: 'failure' },
          { databaseId: 333, headSha: 'abc123', conclusion: 'success' },
        ]),
        stderr: '',
        exitCode: 0,
      };
    }
    if (file === 'gh' && a.startsWith('repo view')) {
      return { stdout: '{"owner":{"login":"o"},"name":"r"}', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && a.includes('actions/runs/111/jobs')) {
      return {
        stdout: JSON.stringify({
          jobs: [
            { id: 9001, name: 'bun (test + lint)', conclusion: 'failure' },
            { id: 9002, name: 'node (test + lint)', conclusion: 'success' },
          ],
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (file === 'gh' && a.includes('actions/jobs/9001/logs')) {
      return {
        stdout: 'FULL LOG LINE 1\nbiome format error\nFULL LOG LINE 3',
        stderr: '',
        exitCode: 0,
      };
    }
    throw new Error(`unexpected call: ${file} ${a}`);
  };
  const g = new GitHubClient('/tmp/repo', run);
  const out = await g.getFailedCiLogs(42);
  // Only run 111 (matches head sha abc123 + failed) and only its failed job 9001.
  assert.equal(out.length, 1);
  assert.equal(out[0]?.check, 'bun (test + lint)');
  assert.match(out[0]?.logs ?? '', /biome format error/);
  // The head sha is filtered server-side and the row cap is a named constant, not a magic 30.
  assert.deepEqual(runListArgs.slice(runListArgs.indexOf('--commit')), ['--commit', 'abc123']);
  assert.deepEqual(
    runListArgs.slice(runListArgs.indexOf('--limit'), runListArgs.indexOf('--limit') + 2),
    ['--limit', String(FAILED_RUN_LIST_LIMIT)],
  );
});

test('getFailedCiLogs never falls back to a stale push run when the head sha has no failed run', async () => {
  // A busy branch: gh returns a failed run for an OLDER push (headSha 'old'), none for the PR's
  // current head 'abc123'. The old code fell back to every failed run and handed the fix Worker
  // these stale logs; the fix must return [] and never fetch that run's jobs.
  const run: RunCmd = async (file, args) => {
    const a = args.join(' ');
    if (file === 'gh' && a.startsWith('pr view')) {
      return { stdout: '{"headRefName":"feat/x","headRefOid":"abc123"}', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && a.startsWith('run list')) {
      return {
        stdout: JSON.stringify([{ databaseId: 222, headSha: 'old', conclusion: 'failure' }]),
        stderr: '',
        exitCode: 0,
      };
    }
    if (file === 'gh' && a.includes('actions/runs/222/jobs')) {
      throw new Error('must not fetch jobs for a stale push run');
    }
    return { stdout: '{"owner":{"login":"o"},"name":"r"}', stderr: '', exitCode: 0 };
  };
  const g = new GitHubClient('/tmp/repo', run);
  assert.deepEqual(await g.getFailedCiLogs(42), []);
});

test('getFailedCiLogs scopes run list by branch only when the head sha is unknown', async () => {
  // No headRefOid → no sha to filter on, so run list must NOT carry --commit and the branch's
  // failed run is used best-effort.
  let runListArgs: string[] = [];
  const run: RunCmd = async (file, args) => {
    const a = args.join(' ');
    if (file === 'gh' && a.startsWith('pr view')) {
      return { stdout: '{"headRefName":"feat/x"}', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && a.startsWith('run list')) {
      runListArgs = [...args];
      return {
        stdout: JSON.stringify([{ databaseId: 111, headSha: 'whatever', conclusion: 'failure' }]),
        stderr: '',
        exitCode: 0,
      };
    }
    if (file === 'gh' && a.startsWith('repo view')) {
      return { stdout: '{"owner":{"login":"o"},"name":"r"}', stderr: '', exitCode: 0 };
    }
    if (file === 'gh' && a.includes('actions/runs/111/jobs')) {
      return {
        stdout: JSON.stringify({ jobs: [{ id: 9001, name: 'ci', conclusion: 'failure' }] }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (file === 'gh' && a.includes('actions/jobs/9001/logs')) {
      return { stdout: 'boom', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected call: ${file} ${a}`);
  };
  const g = new GitHubClient('/tmp/repo', run);
  const out = await g.getFailedCiLogs(42);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.check, 'ci');
  assert.ok(!runListArgs.includes('--commit'));
});

test('getFailedCiLogs returns [] when the PR has no failed runs', async () => {
  const run: RunCmd = async (file, args) => {
    const a = args.join(' ');
    if (a.startsWith('pr view')) {
      return { stdout: '{"headRefName":"feat/x","headRefOid":"abc"}', stderr: '', exitCode: 0 };
    }
    if (a.startsWith('run list')) {
      return {
        stdout: '[{"databaseId":1,"headSha":"abc","conclusion":"success"}]',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const g = new GitHubClient('/tmp/repo', run);
  assert.deepEqual(await g.getFailedCiLogs(42), []);
});

// defaultSleep short-circuits to a microtask under a test runner (NODE_TEST_CONTEXT under
// `node --test`, or explicit AITM_INSTANT_SLEEP=1), so un-injected grace/poll waits don't burn real
// minutes in CI. Production, with neither signal, keeps the real timer. A 1-hour ask must return
// effectively instantly here, under either runtime.
test('defaultSleep: instant under the test runner', async () => {
  assert.ok(isInstantSleepEnabled(), 'precondition: running under a detected test runner');
  const start = Date.now();
  await defaultSleep(60 * 60_000);
  assert.ok(Date.now() - start < 250, 'defaultSleep must not wait real time in tests');
});

const INSTANT_SLEEP_ENV = ['AITM_INSTANT_SLEEP', 'NODE_TEST_CONTEXT'] as const;

// The cancellation path only exists behind the instant-sleep short circuit, so these cases have to
// run with every instant-sleep signal unset — and put them back, or the rest of the file waits out
// real grace periods.
async function withRealTimers(fn: () => Promise<void>): Promise<void> {
  const saved = INSTANT_SLEEP_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of INSTANT_SLEEP_ENV) delete process.env[key];
  try {
    assert.equal(isInstantSleepEnabled(), false, 'precondition: real timers, not the fast path');
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Both leaks are observed through the signal's own removeEventListener: the timer path calls it
// exactly once (listener dropped), and the abort path never does — `{ once: true }` detaches the
// listener internally, so a later call could only come from a timer that outlived the abort.
function countRemovals(signal: AbortSignal): () => number {
  let removals = 0;
  const real = signal.removeEventListener.bind(signal);
  signal.removeEventListener = (
    type: Parameters<typeof real>[0],
    listener: Parameters<typeof real>[1],
    options?: Parameters<typeof real>[2],
  ): void => {
    removals += 1;
    real(type, listener, options);
  };
  return () => removals;
}

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

test('defaultSleep: aborted mid-sleep → resolves without waiting out the delay', async () => {
  await withRealTimers(async () => {
    const controller = new AbortController();
    const start = Date.now();
    const sleeping = defaultSleep(60 * 60_000, controller.signal);
    controller.abort();
    await sleeping;
    assert.ok(Date.now() - start < 1000, 'an aborted sleep must not wait out its delay');
  });
});

test('defaultSleep: aborted mid-sleep → clears the timer, which never fires late', async () => {
  await withRealTimers(async () => {
    const controller = new AbortController();
    const removals = countRemovals(controller.signal);
    const sleeping = defaultSleep(20, controller.signal);
    controller.abort();
    await sleeping;
    await realDelay(120);
    assert.equal(removals(), 0, 'the cleared timer never ran its callback');
  });
});

test('defaultSleep: delay elapsed → removes its abort listener', async () => {
  await withRealTimers(async () => {
    const controller = new AbortController();
    const removals = countRemovals(controller.signal);
    await defaultSleep(5, controller.signal);
    assert.equal(removals(), 1, 'the listener is dropped once the sleep settles');
    controller.abort();
    assert.equal(removals(), 1, 'aborting a settled sleep is inert');
  });
});

test('defaultSleep: already-aborted signal → resolves immediately, arms nothing', async () => {
  await withRealTimers(async () => {
    const controller = new AbortController();
    controller.abort();
    const removals = countRemovals(controller.signal);
    const start = Date.now();
    await defaultSleep(60 * 60_000, controller.signal);
    assert.ok(Date.now() - start < 1000, 'an already-aborted signal skips the wait');
    await realDelay(50);
    assert.equal(removals(), 0, 'no timer and no listener were ever armed');
  });
});

// Every gh/git child gets a deadline and, when the run supplies one, the run's abort handle:
// CHECKS_TIMEOUT_MS bounds how many times waitForChecks polls, never how long one `gh` may hang.
test('execaOptions: no options → the default deadline, nothing else', () => {
  assert.deepEqual(execaOptions(), { timeout: DEFAULT_CMD_TIMEOUT_MS });
});

test('execaOptions: cwd + explicit timeout + signal → execa cwd/timeout/cancelSignal', () => {
  const controller = new AbortController();
  assert.deepEqual(execaOptions({ cwd: '/tmp/repo', timeout: 25, signal: controller.signal }), {
    cwd: '/tmp/repo',
    timeout: 25,
    cancelSignal: controller.signal,
  });
});

test('defaultRunCmd: a child that outruns its deadline → non-zero exit and a legible reason', async () => {
  const r = await defaultRunCmd(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    timeout: 200,
  });
  assert.notEqual(r.exitCode, 0);
  // Callers report failures as `<cmd> failed: <stderr>`; a signal-killed child writes nothing, so
  // without the shortMessage fallback the operator would read an empty reason.
  assert.match(r.stderr, /timed out/i);
});

test('defaultRunCmd: an aborted signal kills the in-flight child instead of orphaning it', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = defaultRunCmd(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const r = await pending;
  assert.notEqual(r.exitCode, 0);
  assert.ok(Date.now() - started < 10_000, 'the child dies on abort, not on its own deadline');
  assert.match(r.stderr, /cancel/i);
});

test('defaultRunCmd: a missing binary → GhCliMissing, not a flattened exit 1', async () => {
  // A spawn ENOENT used to return {exitCode: 1, stderr: ''} — indistinguishable from a real non-zero
  // exit, and callers rendered `<cmd> failed:` with an empty reason. It is now a typed domain error
  // that names the binary and carries execa's own summary (so the reason is surfaced, not dropped).
  await assert.rejects(
    defaultRunCmd('aitm-nonexistent-binary-xyz', ['repo', 'view']),
    (err: unknown) => {
      assert.ok(err instanceof GhCliMissing, 'a spawn ENOENT is a typed domain error, not exit 1');
      assert.match(err.message, /aitm-nonexistent-binary-xyz/);
      assert.match(err.message, /not installed or not on PATH/);
      assert.match(err.message, /ENOENT/);
      return true;
    },
  );
});

test('defaultRunCmd: a real non-zero exit keeps its own code instead of throwing', async () => {
  // The spawn-failure fix must not swallow a genuine non-zero exit: it still returns, with its code.
  const r = await defaultRunCmd(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(r.exitCode, 3);
});

test('defaultRunCmd: a non-zero exit surfaces its own stderr', async () => {
  const r = await defaultRunCmd(process.execPath, ['-e', 'console.error("boom"); process.exit(2)']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /boom/);
});

test('withSignal: binds the run signal into every call, keeping the caller options', async () => {
  const seen: Array<RunCmdOptions | undefined> = [];
  const run: RunCmd = async (_file, _args, options) => {
    seen.push(options);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const controller = new AbortController();
  const bound = withSignal(run, controller.signal);
  await bound('gh', ['pr', 'view']);
  await bound('gh', ['pr', 'view'], { cwd: '/tmp/repo', timeout: 5 });
  assert.deepEqual(seen[0], { signal: controller.signal });
  assert.deepEqual(seen[1], { cwd: '/tmp/repo', timeout: 5, signal: controller.signal });
});

test('GitHubClient: the constructor signal reaches every child spawn', async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const run: RunCmd = async (_file, _args, options) => {
    seen.push(options?.signal);
    return { stdout: 'main\n', stderr: '', exitCode: 0 };
  };
  const controller = new AbortController();
  await new GitHubClient('/tmp/repo', run, defaultSleep, controller.signal).currentBranch();
  assert.deepEqual(seen, [controller.signal]);

  // No run signal → the injected runner is used verbatim, so existing stubs see no extra option.
  const bare: Array<RunCmdOptions | undefined> = [];
  const plain: RunCmd = async (_file, _args, options) => {
    bare.push(options);
    return { stdout: 'main\n', stderr: '', exitCode: 0 };
  };
  await new GitHubClient('/tmp/repo', plain).currentBranch();
  assert.deepEqual(bare, [{ cwd: '/tmp/repo' }]);
});

test('waitForChecks: aborted during the gh call → pending, not a parse failure', async () => {
  // The child is killed mid-flight, so its stdout is truncated garbage. Reporting that as
  // "gh pr checks failed" would turn a clean cancellation into a run-ending error.
  const controller = new AbortController();
  const run: RunCmd = async () => {
    controller.abort();
    return { stdout: '', stderr: 'Command was canceled', exitCode: 1 };
  };
  const g = new GitHubClient('/tmp/repo', run, async () => {}, controller.signal);
  assert.deepEqual(await g.waitForChecks(7, controller.signal), {
    state: 'pending',
    failedChecks: [],
    checks: [],
  });
});

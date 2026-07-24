import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunCmd, RunCmdResult } from './github-client.ts';
import {
  MAX_REVIEW_THREAD_PAGES,
  MAX_THREAD_COMMENT_PAGES,
  paginateReviewThreads,
  paginateThreadComments,
} from './review-threads.ts';

// Local stand-ins for github-client.test.ts's shim helpers — these functions take a plain RunCmd,
// no GitHubClient/repoMeta involved.
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

function findFieldValue(args: readonly string[], flag: '-f' | '-F', key: string): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) {
      const kv = args[i + 1];
      if (typeof kv === 'string' && kv.startsWith(`${key}=`)) return kv.slice(key.length + 1);
    }
  }
  return null;
}

function noopWarn(): void {}

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

test('paginateReviewThreads sends owner/repo/pr variables with no cursor on the first page', async () => {
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
  ]);
  const { run, calls } = makeRun([{ stdout: gql }]);
  const threads = await paginateReviewThreads(run, '/tmp/repo', 'org', 'repo', 42, noopWarn);

  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.id, 'PRRT_1');
  const args = calls[0]?.args ?? [];
  assert.equal(calls[0]?.file, 'gh');
  assert.equal(args[0], 'api');
  assert.equal(args[1], 'graphql');
  assert.equal(findFieldValue(args, '-f', 'owner'), 'org');
  assert.equal(findFieldValue(args, '-f', 'repo'), 'repo');
  assert.equal(findFieldValue(args, '-F', 'pr'), '42');
  assert.equal(findFieldValue(args, '-f', 'threadsCursor'), null);
  const query = findFieldValue(args, '-f', 'query');
  assert.ok(query?.includes('reviewThreads(first: 100, after: $threadsCursor)'));
  assert.ok(query?.includes('pageInfo { hasNextPage endCursor }'));
  assert.ok(query?.includes('pullRequest(number: $pr)'));
  assert.ok(query?.includes('repository(owner: $owner, name: $repo)'));
});

test('paginateReviewThreads pages through with endCursor', async () => {
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
  const { run, calls } = makeRun([{ stdout: page1 }, { stdout: page2 }]);
  const threads = await paginateReviewThreads(run, '/tmp/repo', 'org', 'repo', 7, noopWarn);

  assert.equal(threads.length, 2);
  assert.equal(threads[0]?.id, 'PRRT_1');
  assert.equal(threads[1]?.id, 'PRRT_2');
  // Second page sends the cursor returned by the first page.
  assert.equal(findFieldValue(calls[1]?.args ?? [], '-f', 'threadsCursor'), 'cursor-1');
});

test('paginateReviewThreads throws when GraphQL call fails', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'GraphQL: not found' }]);
  await assert.rejects(
    () => paginateReviewThreads(run, '/tmp/repo', 'org', 'repo', 1, noopWarn),
    /gh api graphql \(reviewThreads\) failed/,
  );
});

test('paginateReviewThreads: exit-0 non-JSON stdout throws naming the command, cause preserved', async () => {
  const { run } = makeRun([{ stdout: 'not json', exitCode: 0 }]);
  await assert.rejects(
    () => paginateReviewThreads(run, '/tmp/repo', 'org', 'repo', 1, noopWarn),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gh api graphql \(reviewThreads\): unparseable JSON stdout/);
      assert.ok(err.cause instanceof SyntaxError, 'JSON.parse SyntaxError is preserved as cause');
      return true;
    },
  );
});

test('paginateReviewThreads stops at max pages', async () => {
  let callCount = 0;
  const run: RunCmd = async () => {
    const pageNum = callCount;
    const hasMore = pageNum < MAX_REVIEW_THREAD_PAGES - 1;
    callCount++;
    return {
      stdout: threadsResponse(
        [
          {
            id: `PRRT_${pageNum}`,
            isResolved: false,
            path: 'a.ts',
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: `IC_${pageNum}`, body: 'x', author: { login: 'r' } }],
            },
          },
        ],
        { hasNextPage: hasMore, endCursor: hasMore ? `cursor-${pageNum}` : null },
      ),
      stderr: '',
      exitCode: 0,
    };
  };
  const warnings: string[] = [];
  const threads = await paginateReviewThreads(run, '/tmp/repo', 'org', 'repo', 7, (m) =>
    warnings.push(m),
  );

  assert.equal(threads.length, MAX_REVIEW_THREAD_PAGES);
  assert.equal(callCount, MAX_REVIEW_THREAD_PAGES, 'should not paginate beyond the cap');
  // The final page ends the connection (hasNextPage: false), so this is not a truncation.
  assert.equal(warnings.length, 0, 'finishing exactly at the cap is not a truncation');
});

test('paginateReviewThreads keeps the stuck page and warns on a non-advancing cursor', async () => {
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
    { hasNextPage: true, endCursor: 'stuck-cursor' },
  );
  // Same cursor (broken pagination) — its threads are kept, then pagination stops.
  const page2 = threadsResponse(
    [
      {
        id: 'PRRT_2',
        isResolved: false,
        path: 'b.ts',
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ id: 'IC_2', body: 'y', author: { login: 'r' } }],
        },
      },
    ],
    { hasNextPage: true, endCursor: 'stuck-cursor' },
  );
  const { run, calls } = makeRun([{ stdout: page1 }, { stdout: page2 }]);
  const warnings: string[] = [];
  const threads = await paginateReviewThreads(run, '/tmp/repo', 'org', 'repo', 7, (m) =>
    warnings.push(m),
  );

  // Both pages' threads survive — the stuck page is no longer silently dropped.
  assert.equal(threads.length, 2);
  assert.deepEqual(
    threads.map((t) => t.id),
    ['PRRT_1', 'PRRT_2'],
  );
  assert.equal(calls.length, 2, 'should detect the non-advancing cursor and stop');
  assert.equal(warnings.length, 1, 'a truncation warning is surfaced');
  assert.match(warnings[0] ?? '', /non-advancing pagination cursor/);
  assert.match(warnings[0] ?? '', /PR #7/);
});

test('paginateReviewThreads dedupes threads a replayed page returns again', async () => {
  const thread = {
    id: 'PRRT_dup',
    isResolved: false,
    path: 'a.ts',
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ id: 'IC_1', body: 'x', author: { login: 'r' } }],
    },
  };
  // GitHub replays the same thread on a non-advancing cursor — the id must not leak twice.
  const page1 = threadsResponse([thread], { hasNextPage: true, endCursor: 'stuck-cursor' });
  const page2 = threadsResponse([thread], { hasNextPage: true, endCursor: 'stuck-cursor' });
  const { run, calls } = makeRun([{ stdout: page1 }, { stdout: page2 }]);
  const threads = await paginateReviewThreads(run, '/tmp/repo', 'org', 'repo', 7, noopWarn);

  assert.deepEqual(
    threads.map((t) => t.id),
    ['PRRT_dup'],
    'the replayed thread is collected once',
  );
  assert.equal(calls.length, 2, 'stops after the non-advancing page');
});

test('paginateReviewThreads warns when hitting the page cap', async () => {
  let callCount = 0;
  // Every page advertises another with an advancing cursor, so pagination stops only when it
  // reaches MAX_REVIEW_THREAD_PAGES — the genuine truncation case (unlike the max-pages test above,
  // whose final page ends the connection naturally).
  const run: RunCmd = async () => {
    const pageNum = callCount;
    callCount++;
    return {
      stdout: threadsResponse(
        [
          {
            id: `PRRT_${pageNum}`,
            isResolved: false,
            path: 'a.ts',
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: `IC_${pageNum}`, body: 'x', author: { login: 'r' } }],
            },
          },
        ],
        { hasNextPage: true, endCursor: `cursor-${pageNum}` },
      ),
      stderr: '',
      exitCode: 0,
    };
  };
  const warnings: string[] = [];
  const threads = await paginateReviewThreads(run, '/tmp/repo', 'org', 'repo', 7, (m) =>
    warnings.push(m),
  );

  assert.equal(threads.length, MAX_REVIEW_THREAD_PAGES, 'keeps every fetched page');
  assert.equal(callCount, MAX_REVIEW_THREAD_PAGES, 'stops at the page cap');
  assert.equal(warnings.length, 1, 'a truncation warning is surfaced');
  assert.match(warnings[0] ?? '', /page cap/);
  assert.match(warnings[0] ?? '', /PR #7/);
});

test('paginateThreadComments sends threadId/cursor variables and pages through', async () => {
  const commentPage1 = commentsResponse([{ id: 'IC_b', body: 'second', author: { login: 'r' } }], {
    hasNextPage: true,
    endCursor: 'c-2',
  });
  const commentPage2 = commentsResponse([{ id: 'IC_c', body: 'third', author: null }]);
  const { run, calls } = makeRun([{ stdout: commentPage1 }, { stdout: commentPage2 }]);
  const comments = await paginateThreadComments(run, '/tmp/repo', 'PRRT_long', 'c-1', noopWarn);

  assert.deepEqual(
    comments.map((c) => c.id),
    ['IC_b', 'IC_c'],
  );
  assert.equal(findFieldValue(calls[0]?.args ?? [], '-f', 'threadId'), 'PRRT_long');
  assert.equal(findFieldValue(calls[0]?.args ?? [], '-f', 'commentsCursor'), 'c-1');
  assert.equal(findFieldValue(calls[1]?.args ?? [], '-f', 'commentsCursor'), 'c-2');
  const query = findFieldValue(calls[0]?.args ?? [], '-f', 'query');
  assert.ok(query?.includes('PullRequestReviewThread'));
  assert.ok(query?.includes('comments(first: 100, after: $commentsCursor)'));
  // A null author maps to null here — listUnresolvedThreads is what maps it to 'ghost'.
  assert.equal(comments[1]?.author, null);
});

test('paginateThreadComments throws when the GraphQL call fails', async () => {
  const { run } = makeRun([{ exitCode: 1, stderr: 'GraphQL: rate limited' }]);
  await assert.rejects(
    () => paginateThreadComments(run, '/tmp/repo', 'PRRT_1', 'c-1', noopWarn),
    /gh api graphql \(threadComments\) failed/,
  );
});

test('paginateThreadComments: exit-0 non-JSON stdout throws naming the command, cause preserved', async () => {
  const { run } = makeRun([{ stdout: 'not json', exitCode: 0 }]);
  await assert.rejects(
    () => paginateThreadComments(run, '/tmp/repo', 'PRRT_1', 'c-1', noopWarn),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /gh api graphql \(threadComments\): unparseable JSON stdout/);
      assert.ok(err.cause instanceof SyntaxError, 'JSON.parse SyntaxError is preserved as cause');
      return true;
    },
  );
});

test('paginateThreadComments breaks on a non-advancing cursor', async () => {
  const commentPage1 = commentsResponse([{ id: 'IC_b', body: 'second', author: { login: 'r' } }], {
    hasNextPage: true,
    endCursor: 'stuck-cursor',
  });
  const commentPage2 = commentsResponse([{ id: 'IC_c', body: 'third', author: { login: 'r' } }], {
    hasNextPage: true,
    endCursor: 'stuck-cursor',
  });
  const { run, calls } = makeRun([{ stdout: commentPage1 }, { stdout: commentPage2 }]);
  const warnings: string[] = [];
  const comments = await paginateThreadComments(run, '/tmp/repo', 'PRRT_long', 'c-1', (m) =>
    warnings.push(m),
  );

  assert.deepEqual(
    comments.map((c) => c.id),
    ['IC_b', 'IC_c'],
  );
  assert.equal(calls.length, 2, 'should detect non-advancing cursor after fetching page 2');
  assert.equal(warnings.length, 1, 'a truncation warning is surfaced');
  assert.match(warnings[0] ?? '', /non-advancing pagination cursor/);
  assert.match(warnings[0] ?? '', /PRRT_long/);
});

test('paginateThreadComments dedupes comments a replayed page returns again', async () => {
  const comment = { id: 'IC_dup', body: 'second', author: { login: 'r' } };
  // Same comment replayed on a non-advancing cursor — collected once, not twice.
  const page1 = commentsResponse([comment], { hasNextPage: true, endCursor: 'stuck-cursor' });
  const page2 = commentsResponse([comment], { hasNextPage: true, endCursor: 'stuck-cursor' });
  const { run, calls } = makeRun([{ stdout: page1 }, { stdout: page2 }]);
  const comments = await paginateThreadComments(run, '/tmp/repo', 'PRRT_long', 'c-1', noopWarn);

  assert.deepEqual(
    comments.map((c) => c.id),
    ['IC_dup'],
    'the replayed comment is collected once',
  );
  assert.equal(calls.length, 2, 'stops after the non-advancing page');
});

test('paginateThreadComments warns when hitting the comment page cap', async () => {
  let callCount = 0;
  // Every comment page advertises another with an advancing cursor → stops only at the cap.
  const run: RunCmd = async () => {
    const n = callCount;
    callCount++;
    return {
      stdout: commentsResponse([{ id: `IC_${n}`, body: 'c', author: { login: 'r' } }], {
        hasNextPage: true,
        endCursor: `cc-${n}`,
      }),
      stderr: '',
      exitCode: 0,
    };
  };
  const warnings: string[] = [];
  const comments = await paginateThreadComments(run, '/tmp/repo', 'PRRT_long', 'c-0', (m) =>
    warnings.push(m),
  );

  assert.equal(comments.length, MAX_THREAD_COMMENT_PAGES);
  assert.equal(callCount, MAX_THREAD_COMMENT_PAGES, 'stops at the comment page cap');
  assert.equal(warnings.length, 1, 'a truncation warning is surfaced');
  assert.match(warnings[0] ?? '', /page cap/);
  assert.match(warnings[0] ?? '', /PRRT_long/);
});

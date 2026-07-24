// docs/github-integration.md — GraphQL pagination for PR review threads and their comments, split
// out of github-client.ts (task #56). Transport (`RunCmd`/`defaultRunCmd`) stays in github-client.ts;
// this module only walks pages and decides when pagination has genuinely finished vs. broken.

import { z } from 'zod';
import { GhCommandFailed } from './errors.ts';
import type { RunCmd } from './github-client.ts';

// GitHub caps connections at 100 nodes per page — these bounds prevent infinite loops on broken
// pagination (non-advancing cursor, infinite pages) while allowing very large PRs.
export const MAX_REVIEW_THREAD_PAGES = 100; // ≈ 10k threads (extremely conservative upper bound)
export const MAX_THREAD_COMMENT_PAGES = 100; // ≈ 10k comments per thread (idem)

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $threadsCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $threadsCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { id body author { login } }
          }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `query($threadId: ID!, $commentsCursor: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $commentsCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id body author { login } }
      }
    }
  }
}`;

const GqlPageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

const GqlReviewCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.object({ login: z.string() }).nullable(),
});
export type RawReviewComment = z.infer<typeof GqlReviewCommentSchema>;

const GqlReviewThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  path: z.string().nullable(),
  comments: z.object({
    pageInfo: GqlPageInfoSchema,
    nodes: z.array(GqlReviewCommentSchema),
  }),
});
export type RawReviewThread = z.infer<typeof GqlReviewThreadSchema>;

const GqlReviewThreadsResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          pageInfo: GqlPageInfoSchema,
          nodes: z.array(GqlReviewThreadSchema),
        }),
      }),
    }),
  }),
});

const GqlThreadCommentsResponseSchema = z.object({
  data: z.object({
    node: z.object({
      comments: z.object({
        pageInfo: GqlPageInfoSchema,
        nodes: z.array(GqlReviewCommentSchema),
      }),
    }),
  }),
});

// gh can exit 0 yet print non-JSON to stdout — a deprecation banner, an HTML error page, an empty
// body. A bare JSON.parse then throws a context-free SyntaxError with no clue which command emitted
// it. The strict parse sites route through this so the throw names the gh command and shows a
// stdout excerpt, keeping the SyntaxError as `cause`.
const GH_STDOUT_EXCERPT_LIMIT = 500;

function parseGhJson(command: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    const trimmed = stdout.trim();
    let excerpt = trimmed === '' ? '<empty>' : trimmed;
    if (excerpt.length > GH_STDOUT_EXCERPT_LIMIT) {
      excerpt = `${excerpt.slice(0, GH_STDOUT_EXCERPT_LIMIT)}... (${trimmed.length} chars total)`;
    }
    throw new Error(`${command}: unparseable JSON stdout: ${excerpt}`, { cause });
  }
}

export async function paginateReviewThreads(
  runCmd: RunCmd,
  cwd: string,
  owner: string,
  repo: string,
  pr: number,
  onWarn: (message: string) => void,
): Promise<RawReviewThread[]> {
  const collected: RawReviewThread[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  let prevEndCursor: string | null = null;
  while (pageCount < MAX_REVIEW_THREAD_PAGES) {
    const args: string[] = [
      'api',
      'graphql',
      '-f',
      `owner=${owner}`,
      '-f',
      `repo=${repo}`,
      '-F',
      `pr=${pr}`,
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
    ];
    if (cursor) args.push('-f', `threadsCursor=${cursor}`);
    const r = await runCmd('gh', args, { cwd });
    if (r.exitCode !== 0) {
      throw new GhCommandFailed('gh api graphql (reviewThreads)', r);
    }
    const parsed = GqlReviewThreadsResponseSchema.parse(
      parseGhJson('gh api graphql (reviewThreads)', r.stdout),
    );
    const conn = parsed.data.repository.pullRequest.reviewThreads;
    pageCount++;
    // Keep this page's threads before deciding whether to stop — both a terminal page and a
    // broken-pagination page carry real threads that must not be dropped.
    collected.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) {
      return collected;
    }
    // Non-advancing cursor → GitHub's pagination is broken; stop after keeping this page.
    if (conn.pageInfo.endCursor === prevEndCursor) {
      onWarn(
        `listUnresolvedThreads: review threads for PR #${pr} truncated after ${pageCount} pages` +
          ' — GitHub returned a non-advancing pagination cursor',
      );
      return collected;
    }
    prevEndCursor = conn.pageInfo.endCursor;
    cursor = conn.pageInfo.endCursor;
  }
  onWarn(
    `listUnresolvedThreads: review threads for PR #${pr} truncated at the ` +
      `${MAX_REVIEW_THREAD_PAGES}-page cap — some threads were not fetched`,
  );
  return collected;
}

export async function paginateThreadComments(
  runCmd: RunCmd,
  cwd: string,
  threadId: string,
  startCursor: string,
  onWarn: (message: string) => void,
): Promise<RawReviewComment[]> {
  const collected: RawReviewComment[] = [];
  let cursor: string = startCursor;
  let pageCount = 0;
  let prevEndCursor: string | null = null;
  while (pageCount < MAX_THREAD_COMMENT_PAGES) {
    const r = await runCmd(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `threadId=${threadId}`,
        '-f',
        `commentsCursor=${cursor}`,
        '-f',
        `query=${THREAD_COMMENTS_QUERY}`,
      ],
      { cwd },
    );
    if (r.exitCode !== 0) {
      throw new GhCommandFailed('gh api graphql (threadComments)', r);
    }
    const parsed = GqlThreadCommentsResponseSchema.parse(
      parseGhJson('gh api graphql (threadComments)', r.stdout),
    );
    const conn = parsed.data.node.comments;
    pageCount++;
    // Keep this page's comments before deciding whether to stop — both a terminal page and a
    // broken-pagination page carry real comments that must not be dropped.
    collected.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) {
      return collected;
    }
    // Non-advancing cursor → GitHub's pagination is broken; stop after keeping this page.
    if (conn.pageInfo.endCursor === prevEndCursor) {
      onWarn(
        `listUnresolvedThreads: comments for thread ${threadId} truncated after ${pageCount} ` +
          'pages — GitHub returned a non-advancing pagination cursor',
      );
      return collected;
    }
    prevEndCursor = conn.pageInfo.endCursor;
    cursor = conn.pageInfo.endCursor;
  }
  onWarn(
    `listUnresolvedThreads: comments for thread ${threadId} truncated at the ` +
      `${MAX_THREAD_COMMENT_PAGES}-page cap — some comments were not fetched`,
  );
  return collected;
}

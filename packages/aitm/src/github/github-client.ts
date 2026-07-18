// docs/github-integration.md, docs/auth.md §"GitHub"
// Only module allowed to shell out to gh. Uses execa (docs/runtime.md — Bun.$ forbidden in src/).

import { ExecaError, execa } from 'execa';
import { z } from 'zod';
import { CiFailed, MergeConflict } from './errors.ts';
import {
  type CheckStatus,
  type PullRequest,
  PullRequestSchema,
  type ReviewThread,
} from './schema.ts';

export type CreatePrInput = {
  title: string;
  body: string;
  base: string;
  head: string;
  draft?: boolean;
  // Every PR `aitm` opens is tagged with this label so it's filterable in the GitHub UI.
  // Falls back to ['ai-task-master'] when not provided. Override via Orchestrator if needed.
  labels?: string[];
};

export const DEFAULT_PR_LABEL = 'ai-task-master';

export type MergeMethod = 'squash' | 'merge' | 'rebase';

// Thin DI shim wrapping execa — lets unit tests assert command shape without spawning processes.
// The actual integration test (PR 12) uses a replay shim. `runCmd` (not `runGh`) because we also
// shell out to plain `git` for `currentBranch`.
export type RunCmdOptions = { cwd?: string };
export type RunCmdResult = { stdout: string; stderr: string; exitCode: number };
export type RunCmd = (
  file: string,
  args: readonly string[],
  options?: RunCmdOptions,
) => Promise<RunCmdResult>;

export const defaultRunCmd: RunCmd = async (file, args, options) => {
  try {
    const r = await execa(file, [...args], options?.cwd ? { cwd: options.cwd } : {});
    return {
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      exitCode: r.exitCode ?? 0,
    };
  } catch (err) {
    if (err instanceof ExecaError) {
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : '',
        exitCode: err.exitCode ?? 1,
      };
    }
    throw err;
  }
};

// Sleep DI — tests inject a recording stub so backoff is asserted without real timers.
export type Sleep = (ms: number) => Promise<void>;

// Real grace/poll waits (REVIEW_COMMENTS_GRACE 2min, CHECKS_START_WAIT_MS 60s, backoff…) are correct in
// the released CLI but would make the test suite crawl. So defaultSleep collapses to a microtask
// under a test runner: `node --test` sets NODE_TEST_CONTEXT in every test child, which is the
// zero-config signal (an explicit env var / NODE_ENV override also works). Tests that assert
// timing/backoff still inject their own recording Sleep and bypass this; this only shortcuts the
// un-injected grace/poll waits that would otherwise burn real minutes in CI.
const INSTANT_SLEEP =
  process.env.AITM_INSTANT_SLEEP === '1' ||
  process.env.NODE_ENV === 'test' ||
  process.env.NODE_TEST_CONTEXT !== undefined;

export const defaultSleep: Sleep = (ms) =>
  INSTANT_SLEEP
    ? Promise.resolve()
    : new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

export const CHECKS_INITIAL_DELAY_MS = 1000;
export const CHECKS_MAX_DELAY_MS = 60_000;
// Hard ceiling on how long waitForChecks polls before giving up — ports claude-task-master's
// CI_POLL_TIMEOUT (120 min). Big CIs can run for a long time; reaching this is the only remaining
// throw path now that failures are returned, not thrown (hence CiFailed is kept strictly for the
// timeout case). On timeout the caller blocks rather than merging a PR whose CI never finished,
// unless --admin is set — see handleWaitingCi.
export const CHECKS_TIMEOUT_MS = 120 * 60_000;

// A push doesn't register its CI checks instantly. Polling immediately would see an empty check
// set, and an empty set has nothing failing or pending — so it would read "CI hasn't started" as
// "CI passed" and merge before a single job runs. waitForChecks sleeps CHECKS_START_WAIT_MS before
// the first poll to let Actions register, and keeps treating an empty set as pending until
// CHECKS_EMPTY_GRACE_MS of polling has also elapsed; only then is the PR deemed to genuinely have
// no checks and reported mergeable.
export const CHECKS_START_WAIT_MS = 60_000;
export const CHECKS_EMPTY_GRACE_MS = 60_000;

// waitForChecks collapses the per-check buckets into one of three states; callers branch on it
// instead of catching a throw. failedChecks is populated only when state is 'failure' (one entry
// per failed/cancelled check) for diagnostics — the fix loop re-downloads full logs via
// getFailedCiLogs(pr) rather than relying on these names.
export type CiState = 'success' | 'failure' | 'pending';
export type FailedCheck = { name: string; status: 'failure' | 'cancelled' };
export type CiResult = { state: CiState; failedChecks: FailedCheck[] };

export class GitHubClient {
  // Capability matrix — docs/github-integration.md §"Capabilities".
  // Backoff — docs/github-integration.md §"Rate limits" (1s, doubling, 60s cap).

  constructor(
    private readonly cwd: string,
    private readonly runCmd: RunCmd = defaultRunCmd,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  async currentBranch(): Promise<string> {
    const r = await this.runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.cwd });
    if (r.exitCode !== 0) {
      throw new Error(`git rev-parse failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout.trim();
  }

  async defaultBranch(): Promise<string> {
    const r = await this.runCmd('gh', ['repo', 'view', '--json', 'defaultBranchRef'], {
      cwd: this.cwd,
    });
    if (r.exitCode !== 0) {
      throw new Error(`gh repo view failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const parsed: unknown = JSON.parse(r.stdout);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'defaultBranchRef' in parsed &&
      typeof parsed.defaultBranchRef === 'object' &&
      parsed.defaultBranchRef !== null &&
      'name' in parsed.defaultBranchRef &&
      typeof parsed.defaultBranchRef.name === 'string'
    ) {
      return parsed.defaultBranchRef.name;
    }
    throw new Error(`gh repo view: unexpected JSON shape: ${r.stdout}`);
  }

  async getPrForBranch(branch: string): Promise<PullRequest | null> {
    const r = await this.runCmd(
      'gh',
      ['pr', 'view', branch, '--json', 'number,state,url,headRefName,baseRefName'],
      { cwd: this.cwd },
    );
    if (r.exitCode !== 0) {
      if (isPrNotFoundStderr(r.stderr)) return null;
      throw new Error(`gh pr view failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return PullRequestSchema.parse(JSON.parse(r.stdout));
  }

  async createPr(input: CreatePrInput): Promise<PullRequest> {
    const labels = input.labels ?? [DEFAULT_PR_LABEL];
    const args: string[] = [
      'pr',
      'create',
      '--title',
      input.title,
      '--body',
      input.body,
      '--base',
      input.base,
      '--head',
      input.head,
    ];
    if (input.draft) args.push('--draft');
    for (const label of labels) args.push('--label', label);

    // `gh pr create --label X` fails if X doesn't exist yet — which it won't on a fresh repo the
    // first time aitm opens a PR. Ensure each label exists first (idempotent via --force; the
    // result is intentionally not checked so a labels-permission gap doesn't block PR creation).
    for (const label of labels) {
      await this.runCmd('gh', ['label', 'create', label, '--force'], { cwd: this.cwd });
    }

    const r = await this.runCmd('gh', args, { cwd: this.cwd });
    if (r.exitCode !== 0) {
      throw new Error(`gh pr create failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    // gh prints the PR URL to stdout; we re-fetch to get the full typed shape.
    const pr = await this.getPrForBranch(input.head);
    if (!pr) {
      throw new Error(
        `gh pr create succeeded for ${input.head} but PR lookup returned null (stdout: ${r.stdout.trim()})`,
      );
    }
    return pr;
  }

  async waitForChecks(pr: number): Promise<CiResult> {
    // Let CI register its checks before the first poll, so a just-pushed PR doesn't read as
    // "passed" off an empty check set — see CHECKS_START_WAIT_MS.
    await this.sleep(CHECKS_START_WAIT_MS);
    let delay = CHECKS_INITIAL_DELAY_MS;
    let waited = 0;
    let emptyWaited = 0;
    while (true) {
      const r = await this.runCmd(
        'gh',
        ['pr', 'checks', String(pr), '--json', 'bucket,name,state'],
        { cwd: this.cwd },
      );
      // `gh pr checks` exits 8 when any check fails but still emits JSON on stdout. Treat any
      // exit code as "command ran" if stdout parses; otherwise propagate the failure.
      const rows = tryParseChecks(r.stdout);
      if (!rows) {
        throw new Error(`gh pr checks failed: ${r.stderr.trim() || r.stdout.trim()}`);
      }
      const status = aggregateChecks(rows);
      if (status === 'failure' || status === 'cancelled') {
        return { state: 'failure', failedChecks: collectFailedChecks(rows) };
      }
      if (status !== 'pending') return { state: 'success', failedChecks: [] };
      // An empty check set aggregates to pending: CI still hasn't registered. Once it has stayed
      // empty past the grace, the PR genuinely has no checks configured and is mergeable.
      if (rows.length === 0 && emptyWaited >= CHECKS_EMPTY_GRACE_MS) {
        return { state: 'success', failedChecks: [] };
      }
      if (waited >= CHECKS_TIMEOUT_MS) {
        throw new CiFailed(`PR #${pr} checks still pending after ${Math.round(waited / 1000)}s`);
      }
      await this.sleep(delay);
      waited += delay;
      emptyWaited = rows.length === 0 ? emptyWaited + delay : 0;
      delay = Math.min(delay * 2, CHECKS_MAX_DELAY_MS);
    }
  }

  // Download the FULL logs of every failed CI job for a PR — no truncation, no ZIP. Mirrors
  // claude-task-master's CILogDownloader: resolve the PR's head run(s), list their jobs via the
  // REST API, keep only the failed ones, and pull each job's complete log text. Returns one entry
  // per failed job. Defensive: a gh failure on any single step yields fewer entries, never a throw,
  // so the merge-pr loop can still proceed (and report "no logs") rather than crash.
  async getFailedCiLogs(pr: number): Promise<Array<{ check: string; logs: string }>> {
    const head = await this.runCmd(
      'gh',
      ['pr', 'view', String(pr), '--json', 'headRefName,headRefOid'],
      { cwd: this.cwd },
    );
    if (head.exitCode !== 0) return [];
    const parsedHead = safeJson(head.stdout);
    const branch = isRecord(parsedHead) ? parsedHead.headRefName : undefined;
    const sha = isRecord(parsedHead) ? parsedHead.headRefOid : undefined;
    if (typeof branch !== 'string') return [];

    const runIds = await this.failedRunIds(branch, typeof sha === 'string' ? sha : undefined);
    if (runIds.length === 0) return [];
    const { owner, name } = await this.repoMeta();
    const out: Array<{ check: string; logs: string }> = [];
    for (const runId of runIds) {
      for (const job of await this.failedJobs(owner, name, runId)) {
        const logs = await this.jobLogs(owner, name, job.id);
        if (logs.trim()) out.push({ check: job.name, logs });
      }
    }
    return out;
  }

  // Run ids of failed/timed-out runs for the branch. When a head sha is known, prefer runs for
  // that exact commit (the PR's current head) so we don't surface logs from a stale push.
  private async failedRunIds(branch: string, sha: string | undefined): Promise<number[]> {
    const r = await this.runCmd(
      'gh',
      [
        'run',
        'list',
        '--branch',
        branch,
        '--json',
        'databaseId,headSha,conclusion',
        '--limit',
        '30',
      ],
      { cwd: this.cwd },
    );
    if (r.exitCode !== 0) return [];
    const parsed = safeJson(r.stdout);
    const rows = WorkflowRunsSchema.safeParse(parsed);
    if (!rows.success) return [];
    const failed = rows.data.filter((run) => FAILED_CONCLUSIONS.has(run.conclusion ?? ''));
    const forSha = sha ? failed.filter((run) => run.headSha === sha) : [];
    return (forSha.length > 0 ? forSha : failed).map((run) => run.databaseId);
  }

  private async failedJobs(
    owner: string,
    name: string,
    runId: number,
  ): Promise<Array<{ id: number; name: string }>> {
    const r = await this.runCmd(
      'gh',
      ['api', `repos/${owner}/${name}/actions/runs/${runId}/jobs`],
      { cwd: this.cwd },
    );
    if (r.exitCode !== 0) return [];
    const parsed = JobsResponseSchema.safeParse(safeJson(r.stdout));
    if (!parsed.success) return [];
    return parsed.data.jobs
      .filter((job) => FAILED_CONCLUSIONS.has(job.conclusion ?? ''))
      .map((job) => ({ id: job.id, name: job.name }));
  }

  // Full per-job log text via the REST API (plain text, not a ZIP). gh prints it to stdout.
  private async jobLogs(owner: string, name: string, jobId: number): Promise<string> {
    const r = await this.runCmd(
      'gh',
      ['api', `repos/${owner}/${name}/actions/jobs/${jobId}/logs`],
      {
        cwd: this.cwd,
      },
    );
    return r.exitCode === 0 ? r.stdout : '';
  }

  async listUnresolvedThreads(pr: number): Promise<ReviewThread[]> {
    const { owner, name } = await this.repoMeta();
    // GitHub caps connections at 100 nodes per page — page through threads and
    // their comments to avoid silently dropping data on large PRs.
    const threads = await this.paginateReviewThreads(owner, name, pr);
    const unresolved = threads.filter((t) => !t.isResolved);
    for (const thread of unresolved) {
      if (thread.comments.pageInfo.hasNextPage && thread.comments.pageInfo.endCursor) {
        const rest = await this.paginateThreadComments(
          thread.id,
          thread.comments.pageInfo.endCursor,
        );
        thread.comments.nodes.push(...rest);
      }
    }
    return unresolved.map((node) => ({
      id: node.id,
      isResolved: node.isResolved,
      path: node.path,
      comments: node.comments.nodes.map((c) => ({
        id: c.id,
        body: c.body,
        author: c.author?.login ?? 'ghost',
      })),
    }));
  }

  private async paginateReviewThreads(
    owner: string,
    repo: string,
    pr: number,
  ): Promise<RawReviewThread[]> {
    const collected: RawReviewThread[] = [];
    let cursor: string | null = null;
    while (true) {
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
      const r = await this.runCmd('gh', args, { cwd: this.cwd });
      if (r.exitCode !== 0) {
        throw new Error(
          `gh api graphql (reviewThreads) failed: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
      const parsed = GqlReviewThreadsResponseSchema.parse(JSON.parse(r.stdout));
      const conn = parsed.data.repository.pullRequest.reviewThreads;
      collected.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return collected;
      cursor = conn.pageInfo.endCursor;
    }
  }

  private async paginateThreadComments(
    threadId: string,
    startCursor: string,
  ): Promise<RawReviewComment[]> {
    const collected: RawReviewComment[] = [];
    let cursor: string | null = startCursor;
    while (cursor) {
      const r = await this.runCmd(
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
        { cwd: this.cwd },
      );
      if (r.exitCode !== 0) {
        throw new Error(
          `gh api graphql (threadComments) failed: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
      const parsed = GqlThreadCommentsResponseSchema.parse(JSON.parse(r.stdout));
      const conn = parsed.data.node.comments;
      collected.push(...conn.nodes);
      cursor =
        conn.pageInfo.hasNextPage && conn.pageInfo.endCursor ? conn.pageInfo.endCursor : null;
    }
    return collected;
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    const r = await this.runCmd(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `threadId=${threadId}`,
        '-f',
        `body=${body}`,
        '-f',
        `query=${REPLY_THREAD_MUTATION}`,
      ],
      { cwd: this.cwd },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `gh api graphql (replyToThread) failed: ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
  }

  async resolveThread(threadId: string): Promise<void> {
    const r = await this.runCmd(
      'gh',
      ['api', 'graphql', '-f', `threadId=${threadId}`, '-f', `query=${RESOLVE_THREAD_MUTATION}`],
      { cwd: this.cwd },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `gh api graphql (resolveThread) failed: ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
  }

  private async repoMeta(): Promise<{ owner: string; name: string }> {
    const r = await this.runCmd('gh', ['repo', 'view', '--json', 'owner,name'], {
      cwd: this.cwd,
    });
    if (r.exitCode !== 0) {
      throw new Error(`gh repo view failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const parsed = RepoOwnerNameSchema.parse(JSON.parse(r.stdout));
    return { owner: parsed.owner.login, name: parsed.name };
  }

  async mergePr(pr: number, method: MergeMethod, opts?: { admin?: boolean }): Promise<void> {
    // `--admin` overrides the base-branch protection policy (e.g. "base branch policy prohibits
    // the merge") when the caller has admin rights on the repo. Off by default.
    const ghArgs = ['pr', 'merge', String(pr), `--${method}`];
    if (opts?.admin) ghArgs.push('--admin');
    const r = await this.runCmd('gh', ghArgs, {
      cwd: this.cwd,
    });
    if (r.exitCode === 0) return;
    const combined = `${r.stderr}\n${r.stdout}`;
    if (/merge conflict|not mergeable|conflict/i.test(combined)) {
      throw new MergeConflict(`Merge conflict on PR #${pr}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    throw new Error(`gh pr merge failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }

  async authStatus(): Promise<{ ok: boolean; scopes: string[] }> {
    const r = await this.runCmd('gh', ['auth', 'status', '--hostname', 'github.com'], {
      cwd: this.cwd,
    });
    // `gh auth status` writes its human-readable summary to stderr; stdout is usually empty.
    const text = `${r.stderr}\n${r.stdout}`;
    const scopes = parseScopes(text);
    return { ok: r.exitCode === 0, scopes };
  }
}

// Conclusions that count as "this job failed and is worth pulling logs for". `cancelled` is
// excluded (intentionally stopped, not a real failure) — same call claude-task-master makes.
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

const WorkflowRunsSchema = z.array(
  z.object({
    databaseId: z.number(),
    headSha: z.string().optional(),
    conclusion: z.string().nullable().optional(),
  }),
);

const JobsResponseSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      conclusion: z.string().nullable().optional(),
    }),
  ),
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// `gh pr view` exits non-zero with messages like:
//   "no pull requests found for branch <name>"
//   "GraphQL: Could not resolve to a PullRequest..."
function isPrNotFoundStderr(stderr: string): boolean {
  return /no pull requests? found|could not resolve to a pullrequest|no open pull requests/i.test(
    stderr,
  );
}

// `gh auth status` line shape: "  - Token scopes: 'repo', 'workflow', 'read:org'"
function parseScopes(text: string): string[] {
  const match = text.match(/Token scopes:\s*([^\n]+)/i);
  if (!match?.[1]) return [];
  const scopes: string[] = [];
  for (const raw of match[1].split(',')) {
    const cleaned = raw.replace(/['"`]/g, '').trim();
    if (cleaned) scopes.push(cleaned);
  }
  return scopes;
}

// Wire shapes for `gh pr checks --json bucket,name,state`. The bucket field is the gh CLI's
// normalized status across providers (Actions, Circle, etc.); CheckStatus is our domain.
const CheckBucketSchema = z.enum(['pass', 'fail', 'pending', 'cancel', 'skipping']);
type CheckBucket = z.infer<typeof CheckBucketSchema>;
const CheckRowSchema = z.object({
  bucket: CheckBucketSchema,
  name: z.string(),
  state: z.string(),
});
const ChecksResponseSchema = z.array(CheckRowSchema);
type CheckRow = z.infer<typeof CheckRowSchema>;

function tryParseChecks(stdout: string): CheckRow[] | null {
  if (!stdout.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = ChecksResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const BUCKET_TO_STATUS: Record<CheckBucket, CheckStatus> = {
  pass: 'success',
  fail: 'failure',
  pending: 'pending',
  cancel: 'cancelled',
  skipping: 'skipped',
};

function aggregateChecks(rows: CheckRow[]): CheckStatus {
  // No rows is not success: right after a push, CI may not have registered its checks yet, so
  // nothing has run. Report pending; waitForChecks bounds how long an empty set stays pending
  // before deciding the PR truly has no checks.
  if (rows.length === 0) return 'pending';
  let pending = false;
  for (const row of rows) {
    const status = BUCKET_TO_STATUS[row.bucket];
    if (status === 'failure') return 'failure';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'pending') pending = true;
  }
  return pending ? 'pending' : 'success';
}

function collectFailedChecks(rows: CheckRow[]): FailedCheck[] {
  const out: FailedCheck[] = [];
  for (const row of rows) {
    const status = BUCKET_TO_STATUS[row.bucket];
    if (status === 'failure' || status === 'cancelled') out.push({ name: row.name, status });
  }
  return out;
}

// `gh repo view --json owner,name` returns `{ owner: { login }, name }`.
const RepoOwnerNameSchema = z.object({
  owner: z.object({ login: z.string() }),
  name: z.string(),
});

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

const REPLY_THREAD_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment { id }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
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
type RawReviewComment = z.infer<typeof GqlReviewCommentSchema>;

const GqlReviewThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  path: z.string().nullable(),
  comments: z.object({
    pageInfo: GqlPageInfoSchema,
    nodes: z.array(GqlReviewCommentSchema),
  }),
});
type RawReviewThread = z.infer<typeof GqlReviewThreadSchema>;

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

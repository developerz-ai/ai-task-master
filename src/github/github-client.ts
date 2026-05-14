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
export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const CHECKS_INITIAL_DELAY_MS = 1000;
export const CHECKS_MAX_DELAY_MS = 60_000;

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

  async waitForChecks(pr: number): Promise<CheckStatus> {
    let delay = CHECKS_INITIAL_DELAY_MS;
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
        throw new CiFailed(`PR #${pr} ${status}: ${summarizeFailures(rows)}`);
      }
      if (status !== 'pending') return status;
      await this.sleep(delay);
      delay = Math.min(delay * 2, CHECKS_MAX_DELAY_MS);
    }
  }

  async listUnresolvedThreads(pr: number): Promise<ReviewThread[]> {
    const { owner, name } = await this.repoMeta();
    const r = await this.runCmd(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${name}`,
        '-F',
        `pr=${pr}`,
        '-f',
        `query=${REVIEW_THREADS_QUERY}`,
      ],
      { cwd: this.cwd },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `gh api graphql (reviewThreads) failed: ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
    const parsed = GqlReviewThreadsResponseSchema.parse(JSON.parse(r.stdout));
    return parsed.data.repository.pullRequest.reviewThreads.nodes
      .filter((node) => !node.isResolved)
      .map((node) => ({
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

  async mergePr(pr: number, method: MergeMethod): Promise<void> {
    const r = await this.runCmd('gh', ['pr', 'merge', String(pr), `--${method}`], {
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
  if (rows.length === 0) return 'success';
  let pending = false;
  for (const row of rows) {
    const status = BUCKET_TO_STATUS[row.bucket];
    if (status === 'failure') return 'failure';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'pending') pending = true;
  }
  return pending ? 'pending' : 'success';
}

function summarizeFailures(rows: CheckRow[]): string {
  const bad = rows.filter((r) => r.bucket === 'fail' || r.bucket === 'cancel');
  if (bad.length === 0) return 'unknown';
  return bad.map((r) => `${r.name}=${r.bucket}`).join(', ');
}

// `gh repo view --json owner,name` returns `{ owner: { login }, name }`.
const RepoOwnerNameSchema = z.object({
  owner: z.object({ login: z.string() }),
  name: z.string(),
});

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          path
          comments(first: 100) {
            nodes { id body author { login } }
          }
        }
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

const GqlReviewThreadsResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              isResolved: z.boolean(),
              path: z.string().nullable(),
              comments: z.object({
                nodes: z.array(
                  z.object({
                    id: z.string(),
                    body: z.string(),
                    author: z.object({ login: z.string() }).nullable(),
                  }),
                ),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

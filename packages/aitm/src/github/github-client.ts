// docs/github-integration.md, docs/auth.md §"GitHub"
// Only module allowed to shell out to gh. Uses execa (docs/runtime.md — Bun.$ forbidden in src/).

import process from 'node:process';
import { ExecaError, execa } from 'execa';
import { z } from 'zod';
import {
  CHECKS_EMPTY_GRACE_MS,
  CHECKS_INITIAL_DELAY_MS,
  CHECKS_MAX_CONSECUTIVE_FAILURES,
  CHECKS_MAX_DELAY_MS,
  CHECKS_START_WAIT_MS,
  CHECKS_TIMEOUT_MS,
  type CheckSummary,
  type CiResult,
  type CiState,
  type FailedCheck,
  pollChecks,
} from './checks-poller.ts';
import { GhCliMissing, GhCommandFailed, MergeConflict } from './errors.ts';
import {
  MAX_REVIEW_THREAD_PAGES,
  MAX_THREAD_COMMENT_PAGES,
  paginateReviewThreads,
  paginateThreadComments,
} from './review-threads.ts';
import { type PullRequest, PullRequestSchema, type ReviewThread } from './schema.ts';

// Re-exported so existing callers/tests importing the poll and pagination constants/types from
// this module keep working — checks-poller.ts and review-threads.ts own the implementations.
export {
  CHECKS_EMPTY_GRACE_MS,
  CHECKS_INITIAL_DELAY_MS,
  CHECKS_MAX_CONSECUTIVE_FAILURES,
  CHECKS_MAX_DELAY_MS,
  CHECKS_START_WAIT_MS,
  CHECKS_TIMEOUT_MS,
  type CheckSummary,
  type CiResult,
  type CiState,
  type FailedCheck,
  MAX_REVIEW_THREAD_PAGES,
  MAX_THREAD_COMMENT_PAGES,
};

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
export type RunCmdOptions = {
  cwd?: string;
  // Per-invocation deadline in ms. Defaults to DEFAULT_CMD_TIMEOUT_MS.
  timeout?: number;
  // Run abort handle. Aborting kills the in-flight child (execa `cancelSignal` → SIGTERM, then
  // SIGKILL) instead of leaving it for the force-exit path to orphan.
  signal?: AbortSignal;
};
export type RunCmdResult = { stdout: string; stderr: string; exitCode: number };
export type RunCmd = (
  file: string,
  args: readonly string[],
  options?: RunCmdOptions,
) => Promise<RunCmdResult>;

// Every child gets a deadline, because nothing else bounds one: CHECKS_TIMEOUT_MS bounds how many
// times waitForChecks polls, never how long a single `gh` may hang. Five minutes is far above any
// healthy call (the slowest is a CI log download) and far below "blocks the run forever".
export const DEFAULT_CMD_TIMEOUT_MS = 5 * 60_000;

// Exported for the unit test: the option mapping is the whole point of the chokepoint, and asserting
// it beats spawning a process per case.
export function execaOptions(options?: RunCmdOptions): {
  cwd?: string;
  timeout: number;
  cancelSignal?: AbortSignal;
} {
  return {
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    timeout: options?.timeout ?? DEFAULT_CMD_TIMEOUT_MS,
    ...(options?.signal ? { cancelSignal: options.signal } : {}),
  };
}

// A child that never exited normally — killed by the deadline or an abort, terminated by a signal,
// or a spawn failure other than ENOENT (which throws) — has an undefined exitCode and usually wrote
// nothing to its own stderr. Every caller reports failures as `<cmd> failed: <stderr>`, so without a
// fallback an operator reads an empty reason. execa's own summary ("Command timed out after 300000
// milliseconds: gh …", "spawn gh EACCES") is that reason.
function failureStderr(err: ExecaError): string {
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  if (stderr.length > 0) return stderr;
  return err.exitCode === undefined ? (err.shortMessage ?? err.message) : '';
}

export const defaultRunCmd: RunCmd = async (file, args, options) => {
  try {
    const r = await execa(file, [...args], execaOptions(options));
    return {
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      exitCode: r.exitCode ?? 0,
    };
  } catch (err) {
    if (err instanceof ExecaError) {
      // The binary isn't on PATH: execa raises a spawn error carrying code 'ENOENT' and no exitCode.
      // Flattening that to {exitCode: 1, stderr: ''} made it indistinguishable from a real non-zero
      // exit, so every caller printed `<cmd> failed:` with an empty reason. A missing gh (or git) is
      // an environment fault the operator must fix, not a per-call failure — raise a typed domain
      // error and carry execa's own summary ("spawn gh ENOENT") so the reason isn't dropped.
      if (err.code === 'ENOENT') {
        throw new GhCliMissing(`${file} is not installed or not on PATH: ${err.shortMessage}`);
      }
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: failureStderr(err),
        exitCode: err.exitCode ?? 1,
      };
    }
    throw err;
  }
};

// Binds the run's abort handle into a RunCmd once, instead of threading it through the twenty-odd
// call sites below — no call site can forget it. Wraps whatever RunCmd it is given, so an injected
// test stub stays in charge. The run signal wins over a per-call one: the run ending is the stronger
// claim, and nothing inside GitHubClient passes its own today.
export const withSignal =
  (run: RunCmd, signal: AbortSignal): RunCmd =>
  (file, args, options) =>
    run(file, args, { ...options, signal });

// Sleep DI — tests inject a recording stub so backoff is asserted without real timers.
// The optional signal makes a wait cancellable; stubs that ignore it stay assignable.
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

// Real grace/poll waits (REVIEW_COMMENTS_GRACE 2min, CHECKS_START_WAIT_MS 60s, backoff…) are correct in
// the released CLI but would make the test suite crawl. So defaultSleep collapses to a microtask
// under a test runner, detected via: AITM_INSTANT_SLEEP=1 (explicit, for any context), or
// NODE_TEST_CONTEXT (set by `node --test`). Tests that assert timing/backoff still inject their own
// recording Sleep and bypass this; this only shortcuts the un-injected grace/poll waits that would
// otherwise burn real minutes in CI.
export const isInstantSleepEnabled = (): boolean =>
  process.env.AITM_INSTANT_SLEEP === '1' || process.env.NODE_TEST_CONTEXT !== undefined;

// The single sleep primitive of the package (mcp/stdio-process-registry.ts polls through it too).
// An abort *resolves* the wait early instead of rejecting: the poll loops own the cancellation shape
// — they re-check `signal.aborted` at the top of each iteration and decide what a cancelled run
// returns — whereas a rejecting sleep would force every backoff/grace site into a try/catch just to
// tell "cancelled" from a real failure. Both settle paths clear the timer and drop the abort listener,
// so a 120-min `waitForChecks` leaves nothing behind on the signal (pattern: worker.ts runEditorFanout).
export const defaultSleep: Sleep = (ms, signal) => {
  if (isInstantSleepEnabled() || signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

// gh caps `run list` at this many rows. getFailedCiLogs also passes `--commit <headSha>` so gh
// filters to the PR's exact head commit server-side — without it, a busy branch's newer/older
// pushes could fill this window and truncate the head's own runs off the list entirely.
export const FAILED_RUN_LIST_LIMIT = 30;

export class GitHubClient {
  // Capability matrix — docs/github-integration.md §"Capabilities".
  // Backoff — docs/github-integration.md §"Rate limits" (1s, doubling, 60s cap).

  private readonly runCmd: RunCmd;

  // `signal` is the run's abort handle: it is bound into every child spawn (see withSignal), so a
  // SIGINT kills an in-flight `gh` rather than orphaning it. Poll cancellation is separate —
  // waitForChecks takes its own signal, since a caller may cancel a wait without ending the run.
  // `now` is the wall clock waitForChecks anchors its timeout budget on. Optional — defaults to
  // Date.now; tests inject a stepped fake so the 120-minute budget is reachable without real time.
  // `onWarn` surfaces non-fatal review-thread pagination truncation (a page cap or a non-advancing
  // cursor left data unfetched) to the operator; defaults to a no-op for callers that never
  // paginate threads (e.g. the auth-status probe).
  constructor(
    private readonly cwd: string,
    runCmd: RunCmd = defaultRunCmd,
    private readonly sleep: Sleep = defaultSleep,
    signal?: AbortSignal,
    private readonly now: () => number = () => Date.now(),
    private readonly onWarn: (message: string) => void = () => {},
  ) {
    this.runCmd = signal ? withSignal(runCmd, signal) : runCmd;
  }

  // The login `gh` is authenticated as, resolved once via `gh api user` and reused, so the review
  // poll never re-spawns the lookup per iteration.
  private cachedLogin: string | null = null;

  // {owner,name} resolved once via `gh repo view` and reused — `listUnresolvedThreads` and
  // `getFailedCiLogs` each call `repoMeta()` per poll iteration (≤30 iters), so without this the
  // review loop spawns a `gh repo view` subprocess every tick for a value that never changes.
  private cachedRepoMeta: { owner: string; name: string } | null = null;

  // Default branch resolved once via `gh repo view` and reused — WorkLoop.runGroup calls
  // defaultBranch() per group, and it never changes mid-run, so without this a multi-group run
  // spawns a `gh repo view` subprocess per group instead of once.
  private cachedDefaultBranch: string | null = null;

  // Labels created once per run via `gh label create --force` and reused — createPr is called
  // once per PR group, and the label set never changes mid-run, so without this a multi-group run
  // spawns a `gh label create` subprocess per label per group instead of once.
  private cachedLabels: Set<string> | null = null;

  async currentBranch(): Promise<string> {
    const r = await this.runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.cwd });
    if (r.exitCode !== 0) {
      throw new GhCommandFailed('git rev-parse', r);
    }
    return r.stdout.trim();
  }

  async defaultBranch(): Promise<string> {
    if (this.cachedDefaultBranch !== null) return this.cachedDefaultBranch;
    const r = await this.runCmd('gh', ['repo', 'view', '--json', 'defaultBranchRef'], {
      cwd: this.cwd,
    });
    if (r.exitCode !== 0) {
      throw new GhCommandFailed('gh repo view', r);
    }
    const parsed = DefaultBranchRefSchema.safeParse(parseGhJson('gh repo view', r.stdout));
    if (!parsed.success) {
      throw new GhCommandFailed('gh repo view', r);
    }
    const branchName = parsed.data.defaultBranchRef?.name;
    if (typeof branchName !== 'string') {
      throw new GhCommandFailed('gh repo view', r);
    }
    this.cachedDefaultBranch = branchName;
    return this.cachedDefaultBranch;
  }

  async getPrForBranch(branch: string): Promise<PullRequest | null> {
    const r = await this.runCmd(
      'gh',
      ['pr', 'view', branch, '--json', 'number,state,url,headRefName,baseRefName'],
      { cwd: this.cwd },
    );
    if (r.exitCode !== 0) {
      if (isPrNotFoundStderr(r.stderr)) return null;
      throw new GhCommandFailed('gh pr view', r);
    }
    return PullRequestSchema.parse(parseGhJson('gh pr view', r.stdout));
  }

  async createPr(input: CreatePrInput): Promise<PullRequest> {
    // Idempotent open: if a PR already exists for this head, adopt it instead of opening a second
    // one. A kill between `gh pr create` and persisting the PR number otherwise resumes into a
    // re-create that `gh` rejects ("a pull request for branch … already exists"), blocking the
    // group. This is the same lookup as the post-create refetch below, moved ahead of the create.
    const existing = await this.getPrForBranch(input.head);
    if (existing) return existing;

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
    // Cache created labels once per run to avoid repeated subprocess calls.
    if (this.cachedLabels === null) {
      this.cachedLabels = new Set();
    }
    for (const label of labels) {
      if (!this.cachedLabels.has(label)) {
        await this.runCmd('gh', ['label', 'create', label, '--force'], { cwd: this.cwd });
        this.cachedLabels.add(label);
      }
    }

    const r = await this.runCmd('gh', args, { cwd: this.cwd });
    if (r.exitCode !== 0) {
      throw new GhCommandFailed('gh pr create', r);
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

  // `signal` cancels the wait (SIGINT): both the start grace and the backoff resolve early on
  // abort, and the poll then returns a NON-VERDICT `pending` result instead of a settled one.
  // Callers must re-check the signal before acting on the result — see handleWaitingCi. The
  // poll/backoff/tolerance policy itself lives in checks-poller.ts; this is transport wiring only.
  async waitForChecks(pr: number, signal?: AbortSignal): Promise<CiResult> {
    return pollChecks(this.runCmd, this.cwd, pr, this.sleep, this.now, signal);
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

  // Run ids of failed/timed-out runs to pull logs from. When the PR's head sha is known, gh filters
  // to that exact commit server-side (`--commit`), so `--limit` truncation on a busy branch can't
  // push the head's own runs off the list — and we never widen to other commits, which would hand
  // the fix Worker logs from a stale push. Without a sha (headRefOid missing) we can only scope by
  // branch.
  private async failedRunIds(branch: string, sha: string | undefined): Promise<number[]> {
    const args = [
      'run',
      'list',
      '--branch',
      branch,
      '--json',
      'databaseId,headSha,conclusion',
      '--limit',
      String(FAILED_RUN_LIST_LIMIT),
    ];
    if (sha) args.push('--commit', sha);
    const r = await this.runCmd('gh', args, { cwd: this.cwd });
    if (r.exitCode !== 0) return [];
    const rows = WorkflowRunsSchema.safeParse(safeJson(r.stdout));
    if (!rows.success) return [];
    const failed = rows.data.filter((run) => FAILED_CONCLUSIONS.has(run.conclusion ?? ''));
    // `--commit` already scoped server-side; re-check headSha as belt-and-braces so a row for any
    // other commit is dropped rather than surfaced as this PR's failure. No fallback: an empty
    // result means the head has no failed run, and stale-push logs are worse than none.
    const scoped = sha ? failed.filter((run) => run.headSha === sha) : failed;
    return scoped.map((run) => run.databaseId);
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
    // their comments to avoid silently dropping data on large PRs. Pagination itself lives in
    // review-threads.ts; this method owns only repo-meta resolution and the response shape.
    const threads = await paginateReviewThreads(
      this.runCmd,
      this.cwd,
      owner,
      name,
      pr,
      this.onWarn,
    );
    const unresolved = threads.filter((t) => !t.isResolved);
    for (const thread of unresolved) {
      if (thread.comments.pageInfo.hasNextPage && thread.comments.pageInfo.endCursor) {
        const rest = await paginateThreadComments(
          this.runCmd,
          this.cwd,
          thread.id,
          thread.comments.pageInfo.endCursor,
          this.onWarn,
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
      throw new GhCommandFailed('gh api graphql (replyToThread)', r);
    }
  }

  async resolveThread(threadId: string): Promise<void> {
    const r = await this.runCmd(
      'gh',
      ['api', 'graphql', '-f', `threadId=${threadId}`, '-f', `query=${RESOLVE_THREAD_MUTATION}`],
      { cwd: this.cwd },
    );
    if (r.exitCode !== 0) {
      throw new GhCommandFailed('gh api graphql (resolveThread)', r);
    }
  }

  // The login `gh` is authenticated as. The addressing-reviews loop uses it to recognize the
  // Reviewer's own replies on a thread and skip a thread it already replied to — self-healing dedup
  // that survives a crash between the reply and the addressed-thread record (durability #5). Throws
  // on a gh failure; the review loop's use of it is best-effort and degrades to the addressed-set
  // record when it can't resolve.
  async authenticatedLogin(): Promise<string> {
    if (this.cachedLogin !== null) return this.cachedLogin;
    const r = await this.runCmd('gh', ['api', 'user', '--jq', '.login'], { cwd: this.cwd });
    if (r.exitCode !== 0) {
      throw new GhCommandFailed('gh api user', r);
    }
    const login = r.stdout.trim();
    if (login === '') {
      throw new Error('gh api user returned an empty login');
    }
    this.cachedLogin = login;
    return login;
  }

  private async repoMeta(): Promise<{ owner: string; name: string }> {
    if (this.cachedRepoMeta !== null) return this.cachedRepoMeta;
    const r = await this.runCmd('gh', ['repo', 'view', '--json', 'owner,name'], {
      cwd: this.cwd,
    });
    if (r.exitCode !== 0) {
      throw new GhCommandFailed('gh repo view', r);
    }
    const parsed = RepoOwnerNameSchema.parse(parseGhJson('gh repo view', r.stdout));
    this.cachedRepoMeta = { owner: parsed.owner.login, name: parsed.name };
    return this.cachedRepoMeta;
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
    // Idempotent: merging an already-merged PR is not a failure — the desired end state is already
    // true. This happens on a resume that re-drives the merge stage after a crash between mergePr
    // succeeding on GitHub and state.json persisting 'merged'. Confirm against the PR's REAL state
    // rather than gh's message wording, which "already merged" phrases differently across versions
    // (and which can read as "not mergeable", the same words a genuine conflict uses). Checked before
    // the conflict branch so an already-merged PR is never misreported as a conflict.
    if (await this.isMerged(pr)) return;
    const combined = `${r.stderr}\n${r.stdout}`;
    if (/merge conflict|not mergeable/i.test(combined)) {
      throw new MergeConflict(`Merge conflict on PR #${pr}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    throw new GhCommandFailed('gh pr merge', r);
  }

  // Whether the PR is already in the terminal MERGED state. Best-effort: a failed/unparseable state
  // query returns false, so a real merge failure still surfaces rather than being swallowed.
  private async isMerged(pr: number): Promise<boolean> {
    const r = await this.runCmd('gh', ['pr', 'view', String(pr), '--json', 'state'], {
      cwd: this.cwd,
    });
    if (r.exitCode !== 0) return false;
    try {
      const parsed: unknown = JSON.parse(r.stdout);
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        'state' in parsed &&
        (parsed as { state: unknown }).state === 'MERGED'
      );
    } catch {
      return false;
    }
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

// gh can exit 0 yet print non-JSON to stdout — a deprecation banner, an HTML error page, an empty
// body. A bare JSON.parse then throws a context-free SyntaxError with no clue which command emitted
// it. The strict parse sites route through this so the throw names the gh command and shows a
// stdout excerpt, keeping the SyntaxError as `cause`. Mirrors safeJson but surfaces the failure
// instead of degrading to null — these callers must not proceed on garbage. review-threads.ts has
// its own copy for the same reason (transport stays here; that module owns pagination only).
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

// `gh repo view --json owner,name` returns `{ owner: { login }, name }`.
const RepoOwnerNameSchema = z.object({
  owner: z.object({ login: z.string() }),
  name: z.string(),
});

// `gh repo view --json defaultBranchRef` returns `{ defaultBranchRef: { name } }`.
const DefaultBranchRefSchema = z.object({
  defaultBranchRef: z
    .object({
      name: z.string(),
    })
    .nullable(),
});

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

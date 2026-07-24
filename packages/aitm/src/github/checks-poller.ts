// docs/github-integration.md §"Rate limits" / §"Poll timeout" — waitForChecks' poll/backoff/
// tolerance policy, split out of github-client.ts (task #56) so it's testable without spawning
// `gh` through the full GitHubClient. Transport (`RunCmd`/`defaultRunCmd`) stays in github-client.ts;
// this module only decides WHEN to keep polling and HOW to read one poll's result.

import { z } from 'zod';
import { isToleratedFailure } from './check-tolerance.ts';
import { CiFailed, GhCommandFailed } from './errors.ts';
import type { RunCmd, RunCmdResult, Sleep } from './github-client.ts';
import type { CheckStatus } from './schema.ts';

// GraphQL pagination bounds live in review-threads.ts. These are the checks-poll bounds.
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
// "CI passed" and merge before a single job runs. pollChecks sleeps CHECKS_START_WAIT_MS before
// the first poll to let Actions register, and keeps treating an empty set as pending until
// CHECKS_EMPTY_GRACE_MS of polling has also elapsed; only then is the PR deemed to genuinely have
// no checks and reported mergeable.
export const CHECKS_START_WAIT_MS = 60_000;
export const CHECKS_EMPTY_GRACE_MS = 60_000;

// A single unparseable/failed `gh pr checks` read is noise — a truncated stdout, a network blip, a
// transient gh error — and must not abandon a wait that can legitimately run for the full 120-minute
// budget. pollChecks tolerates this many CONSECUTIVE bad reads (any good read resets the count),
// polling through them on the same backoff, and only then gives up with GhCommandFailed. A genuinely
// broken environment (auth revoked mid-run, gh removed) fails every read and so still surfaces fast.
// A checkless PR is NOT a failed read — see readCheckRows — so it never counts toward this.
export const CHECKS_MAX_CONSECUTIVE_FAILURES = 5;

// pollChecks collapses the per-check buckets into one of three states; callers branch on it
// instead of catching a throw. failedChecks is populated only when state is 'failure' (one entry
// per failed/cancelled check) for diagnostics — the fix loop re-downloads full logs via
// getFailedCiLogs(pr) rather than relying on these names.
export type CiState = 'success' | 'failure' | 'pending';
export type FailedCheck = { name: string; status: 'failure' | 'cancelled' };
// One settled check: its name and gh's bucket ('pass' | 'fail' | 'skipping' | 'cancel' | …). Carried
// so the caller can print ONE summary line of what CI showed when it settled, without re-querying.
export type CheckSummary = { name: string; bucket: string };
export type CiResult = {
  state: CiState;
  failedChecks: FailedCheck[];
  // The final check rows at settle time, for a one-time summary. Optional so existing stubs/callers
  // that only branch on `state`/`failedChecks` stay valid.
  checks?: CheckSummary[];
};

// Wire shapes for `gh pr checks --json bucket,name,state,description`. The bucket field is the
// gh CLI's normalized status across providers (Actions, Circle, etc.); CheckStatus is our domain.
// `description` is the reporting service's free-text reason — the only way to tell a tolerated
// failure (see check-tolerance.ts) from a real one.
const CheckBucketSchema = z.enum(['pass', 'fail', 'pending', 'cancel', 'skipping']);
type CheckBucket = z.infer<typeof CheckBucketSchema>;
const CheckRowSchema = z.object({
  bucket: CheckBucketSchema,
  name: z.string(),
  state: z.string(),
  description: z.string().optional(),
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

// A PR with no checks configured is not a failed poll. `gh pr checks --json` prints its rows to
// stdout for every real check state (even exit 8 when one fails), but for a checkless PR it writes
// nothing to stdout and exits non-zero with "no checks reported on the '<branch>' branch" on stderr.
// Match that exact case so it becomes an empty row set — anything else with an empty/garbage stdout
// (an auth or network error) must stay a failure, not be waved through as a mergeable "no checks".
function isNoChecksReported(r: RunCmdResult): boolean {
  return r.exitCode !== 0 && r.stdout.trim() === '' && /no checks reported/i.test(r.stderr);
}

// One poll's rows, or null when the read itself failed and should be retried. Collapses a checkless
// PR to an empty set (→ enters CHECKS_EMPTY_GRACE_MS) and leaves genuine read failures as null (→
// counted against CHECKS_MAX_CONSECUTIVE_FAILURES), so pollChecks never confuses the two.
function readCheckRows(r: RunCmdResult): CheckRow[] | null {
  const rows = tryParseChecks(r.stdout);
  if (rows) return rows;
  return isNoChecksReported(r) ? [] : null;
}

const BUCKET_TO_STATUS: Record<CheckBucket, CheckStatus> = {
  pass: 'success',
  fail: 'failure',
  pending: 'pending',
  cancel: 'cancelled',
  skipping: 'skipped',
};

// A failed row whose (name, description) pair is whitelisted counts as skipped, so a rate-limited
// review bot can neither fail the PR nor be reported as something to fix.
function effectiveStatus(row: CheckRow): CheckStatus {
  const status = BUCKET_TO_STATUS[row.bucket];
  if ((status === 'failure' || status === 'cancelled') && isToleratedFailure(row)) return 'skipped';
  return status;
}

function aggregateChecks(rows: CheckRow[]): CheckStatus {
  // No rows is not success: right after a push, CI may not have registered its checks yet, so
  // nothing has run. Report pending; pollChecks bounds how long an empty set stays pending
  // before deciding the PR truly has no checks.
  if (rows.length === 0) return 'pending';
  let pending = false;
  for (const row of rows) {
    const status = effectiveStatus(row);
    if (status === 'failure') return 'failure';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'pending') pending = true;
  }
  return pending ? 'pending' : 'success';
}

// The settled rows as {name, bucket} for a one-line CI summary. Dedupes by name (gh can list a matrix
// job's shards separately) keeping the first, so the summary reads one line per named check.
function summarize(rows: CheckRow[]): CheckSummary[] {
  const seen = new Set<string>();
  const out: CheckSummary[] = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.push({ name: row.name, bucket: row.bucket });
  }
  return out;
}

function collectFailedChecks(rows: CheckRow[]): FailedCheck[] {
  const out: FailedCheck[] = [];
  for (const row of rows) {
    const status = effectiveStatus(row);
    if (status === 'failure' || status === 'cancelled') out.push({ name: row.name, status });
  }
  return out;
}

// Poll `gh pr checks` until it settles success/failure or the CHECKS_TIMEOUT_MS budget is exhausted.
// `signal` cancels the wait (SIGINT): both the start grace and the backoff resolve early on abort,
// and the poll then returns a NON-VERDICT `pending` result instead of a settled one. Callers must
// re-check the signal before acting on the result — see handleWaitingCi.
export async function pollChecks(
  runCmd: RunCmd,
  cwd: string,
  pr: number,
  sleep: Sleep,
  now: () => number = () => Date.now(),
  signal?: AbortSignal,
): Promise<CiResult> {
  // The timeout budget is wall-clock, anchored here. Accumulating only the backoff `delay` (as this
  // once did) left the 60s start grace below and every poll's subprocess wall-time uncounted, so a
  // run of slow or near-deadline (5-min) `gh pr checks` calls could outlast the 120-minute ceiling
  // many times over. `now()` includes all of it.
  const start = now();
  // Let CI register its checks before the first poll, so a just-pushed PR doesn't read as
  // "passed" off an empty check set — see CHECKS_START_WAIT_MS.
  await sleep(CHECKS_START_WAIT_MS, signal);
  let delay = CHECKS_INITIAL_DELAY_MS;
  let emptyWaited = 0;
  let consecutiveFailures = 0;
  while (true) {
    // A cancelled run stops here. The sleeps RESOLVE on abort rather than rejecting (see
    // defaultSleep), so without this check a SIGINT would only make the loop spin faster —
    // spawning a `gh pr checks` subprocess per tick until the 120-minute timeout.
    if (signal?.aborted) return { state: 'pending', failedChecks: [], checks: [] };
    const r = await runCmd(
      'gh',
      ['pr', 'checks', String(pr), '--json', 'bucket,name,state,description'],
      {
        cwd,
      },
    );
    // An abort kills the child mid-flight, so its stdout is truncated or empty — parsing it would
    // report "gh pr checks failed" for what is really a cancellation. Same non-verdict as above.
    if (signal?.aborted) return { state: 'pending', failedChecks: [], checks: [] };
    // A checkless PR (→ empty set) and a transient read failure (→ null) are the two non-JSON
    // exits; readCheckRows tells them apart so neither is misread as the other.
    const rows = readCheckRows(r);
    let sawEmptyRows = false;
    if (rows) {
      consecutiveFailures = 0;
      const status = aggregateChecks(rows);
      if (status === 'failure' || status === 'cancelled') {
        return {
          state: 'failure',
          failedChecks: collectFailedChecks(rows),
          checks: summarize(rows),
        };
      }
      if (status !== 'pending')
        return { state: 'success', failedChecks: [], checks: summarize(rows) };
      // An empty check set aggregates to pending: CI still hasn't registered, or the PR has none.
      // Once it has stayed empty past the grace, the PR genuinely has no checks and is mergeable.
      if (rows.length === 0 && emptyWaited >= CHECKS_EMPTY_GRACE_MS) {
        return { state: 'success', failedChecks: [], checks: [] };
      }
      sawEmptyRows = rows.length === 0;
    } else {
      // One unparseable read is noise; a run of them is a real break. Poll through up to
      // CHECKS_MAX_CONSECUTIVE_FAILURES in a row, then surface the last failure.
      consecutiveFailures += 1;
      if (consecutiveFailures >= CHECKS_MAX_CONSECUTIVE_FAILURES) {
        throw new GhCommandFailed('gh pr checks', r);
      }
    }
    const elapsed = now() - start;
    if (elapsed >= CHECKS_TIMEOUT_MS) {
      throw new CiFailed(`PR #${pr} checks still pending after ${Math.round(elapsed / 1000)}s`);
    }
    await sleep(delay, signal);
    // A failed read is not an empty check set, so it resets the empty grace rather than advancing it.
    emptyWaited = sawEmptyRows ? emptyWaited + delay : 0;
    delay = Math.min(delay * 2, CHECKS_MAX_DELAY_MS);
  }
}

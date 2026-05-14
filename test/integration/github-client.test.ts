// Integration: GitHubClient against a fake `gh` shim.
//
// Exercises the full flow: PR create → checks polling → thread fetch → merge.
// Uses a sequence-replay RunCmd shim and a timing Sleep shim so no real processes
// are spawned and no real timers fire — but timestamp ordering is still asserted.
//
// Backoff scenario: 7 pending replies before success → sleep delays recorded as
// [1000, 2000, 4000, 8000, 16000, 32000, 60000] with monotonically-increasing `at` timestamps.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiFailed, MergeConflict } from '../../src/github/errors.ts';
import {
  CHECKS_INITIAL_DELAY_MS,
  CHECKS_MAX_DELAY_MS,
  DEFAULT_PR_LABEL,
  GitHubClient,
  type RunCmd,
  type RunCmdResult,
  type Sleep,
} from '../../src/github/github-client.ts';

// ── Shim factories ──────────────────────────────────────────────────────────

type CannedReply = Partial<RunCmdResult>;

type CmdCall = { file: string; args: string[] };

function makeRunShim(replies: CannedReply[]): { run: RunCmd; calls: CmdCall[] } {
  const calls: CmdCall[] = [];
  const run: RunCmd = async (file, args) => {
    const idx = calls.length;
    calls.push({ file, args: [...args] });
    const reply = replies[idx];
    if (reply === undefined) {
      throw new Error(`No canned reply for call #${idx}: ${file} ${args.join(' ')}`);
    }
    return {
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode ?? 0,
    };
  };
  return { run, calls };
}

type SleepRecord = { delay: number; at: number };

function makeTimingSleep(): { sleep: Sleep; records: SleepRecord[] } {
  const records: SleepRecord[] = [];
  const sleep: Sleep = async (ms) => {
    records.push({ delay: ms, at: performance.now() });
  };
  return { sleep, records };
}

// ── Canned data ─────────────────────────────────────────────────────────────

const PR_HEAD = 'feat/my-feature';
const PR_BASE = 'main';

const cannedPr = {
  number: 42,
  state: 'OPEN',
  url: 'https://github.com/org/repo/pull/42',
  headRefName: PR_HEAD,
  baseRefName: PR_BASE,
};

const cannedMeta = { owner: { login: 'org' }, name: 'repo' };

function checksJson(bucket: 'pending' | 'pass' | 'fail' | 'cancel'): string {
  return JSON.stringify([{ bucket, name: 'ci', state: bucket.toUpperCase() }]);
}

function threadsJson(opts: {
  unresolvedCount: number;
  resolvedCount?: number;
  paginated?: boolean;
}): string {
  const nodes = [];
  for (let i = 0; i < opts.unresolvedCount; i++) {
    nodes.push({
      id: `PRRT_u${i}`,
      isResolved: false,
      path: `src/file${i}.ts`,
      comments: {
        pageInfo: {
          hasNextPage: opts.paginated === true && i === 0,
          endCursor: opts.paginated === true && i === 0 ? 'cursor-next' : null,
        },
        nodes: [{ id: `IC_${i}`, body: `review comment ${i}`, author: { login: 'reviewer' } }],
      },
    });
  }
  for (let i = 0; i < (opts.resolvedCount ?? 0); i++) {
    nodes.push({
      id: `PRRT_r${i}`,
      isResolved: true,
      path: `src/resolved${i}.ts`,
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [],
      },
    });
  }
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
        },
      },
    },
  });
}

function extraCommentsJson(ids: string[]): string {
  return JSON.stringify({
    data: {
      node: {
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: ids.map((id) => ({ id, body: `extra ${id}`, author: { login: 'r' } })),
        },
      },
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('full happy-path: create PR → poll checks × 2 → fetch threads → merge', async () => {
  const replies: CannedReply[] = [
    // 1. createPr → gh pr create (returns URL to stdout)
    { stdout: `https://github.com/org/repo/pull/42\n` },
    // 2. createPr → internal getPrForBranch re-fetch
    { stdout: JSON.stringify(cannedPr) },
    // 3. waitForChecks call 1: pending
    { stdout: checksJson('pending') },
    // 4. waitForChecks call 2: pending
    { stdout: checksJson('pending') },
    // 5. waitForChecks call 3: pass
    { stdout: checksJson('pass') },
    // 6. listUnresolvedThreads → repoMeta
    { stdout: JSON.stringify(cannedMeta) },
    // 7. listUnresolvedThreads → GraphQL reviewThreads
    { stdout: threadsJson({ unresolvedCount: 1, resolvedCount: 1 }) },
    // 8. mergePr
    { stdout: 'Merged ✓\n' },
  ];

  const { run, calls } = makeRunShim(replies);
  const { sleep, records } = makeTimingSleep();
  const client = new GitHubClient('/tmp/repo', run, sleep);

  // ── createPr ───────────────────────────────────────────────────────────────
  const pr = await client.createPr({
    title: 'feat: my feature',
    body: 'adds things',
    base: PR_BASE,
    head: PR_HEAD,
  });
  assert.equal(pr.number, 42);
  assert.equal(pr.state, 'OPEN');
  assert.equal(pr.headRefName, PR_HEAD);

  // Verify args: create call
  const createArgs = calls[0]?.args ?? [];
  assert.equal(calls[0]?.file, 'gh');
  assert.ok(createArgs.includes('pr'));
  assert.ok(createArgs.includes('create'));
  assert.ok(createArgs.includes('--title'));
  assert.ok(createArgs.includes('--label'));
  assert.ok(createArgs.includes(DEFAULT_PR_LABEL));
  assert.equal(createArgs[createArgs.indexOf('--base') + 1], PR_BASE);
  assert.equal(createArgs[createArgs.indexOf('--head') + 1], PR_HEAD);

  // Re-fetch call
  assert.equal(calls[1]?.file, 'gh');
  assert.deepEqual(calls[1]?.args.slice(0, 3), ['pr', 'view', PR_HEAD]);

  // ── waitForChecks ──────────────────────────────────────────────────────────
  const status = await client.waitForChecks(pr.number);
  assert.equal(status, 'success');

  // Two pending polls → two sleep calls
  assert.equal(records.length, 2);
  assert.equal(records[0]?.delay, CHECKS_INITIAL_DELAY_MS);
  assert.equal(records[1]?.delay, CHECKS_INITIAL_DELAY_MS * 2);

  // Timestamps are monotonically non-decreasing (fake sleep is instant but ordering is stable)
  assert.ok((records[1]?.at ?? 0) >= (records[0]?.at ?? 0));

  // Check calls have the right PR number
  const checkArgs = calls[2]?.args ?? [];
  assert.deepEqual(checkArgs, ['pr', 'checks', '42', '--json', 'bucket,name,state']);

  // ── listUnresolvedThreads ──────────────────────────────────────────────────
  const threads = await client.listUnresolvedThreads(pr.number);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.id, 'PRRT_u0');
  assert.equal(threads[0]?.isResolved, false);
  assert.equal(threads[0]?.path, 'src/file0.ts');
  assert.equal(threads[0]?.comments.length, 1);
  assert.equal(threads[0]?.comments[0]?.body, 'review comment 0');
  assert.equal(threads[0]?.comments[0]?.author, 'reviewer');

  // repoMeta call
  assert.deepEqual(calls[5]?.args, ['repo', 'view', '--json', 'owner,name']);
  // GraphQL call includes pr number and owner/repo -F/-f fields
  const gqlArgs = calls[6]?.args ?? [];
  assert.equal(gqlArgs[0], 'api');
  assert.equal(gqlArgs[1], 'graphql');
  const prFieldIdx = gqlArgs.indexOf('-F');
  assert.ok(prFieldIdx !== -1);
  assert.equal(gqlArgs[prFieldIdx + 1], 'pr=42');

  // ── mergePr ────────────────────────────────────────────────────────────────
  await client.mergePr(pr.number, 'squash');
  assert.deepEqual(calls[7]?.args, ['pr', 'merge', '42', '--squash']);

  assert.equal(calls.length, 8);
});

test('backoff: 7 pending → success → delays [1s,2s,4s,8s,16s,32s,60s] capped', async () => {
  const replies: CannedReply[] = [
    ...Array.from({ length: 7 }, () => ({ stdout: checksJson('pending') })),
    { stdout: checksJson('pass') },
  ];

  const { run } = makeRunShim(replies);
  const { sleep, records } = makeTimingSleep();
  const client = new GitHubClient('/tmp/repo', run, sleep);

  const status = await client.waitForChecks(1);
  assert.equal(status, 'success');

  const expectedDelays = [1000, 2000, 4000, 8000, 16_000, 32_000, CHECKS_MAX_DELAY_MS];
  assert.equal(records.length, 7);
  assert.deepEqual(
    records.map((r) => r.delay),
    expectedDelays,
  );

  // All timestamps are finite numbers (performance.now() values)
  for (const rec of records) {
    assert.ok(Number.isFinite(rec.at));
    assert.ok(rec.at >= 0);
  }

  // Timestamps are monotonically non-decreasing
  for (let i = 1; i < records.length; i++) {
    assert.ok((records[i]?.at ?? 0) >= (records[i - 1]?.at ?? 0));
  }

  // Constants match spec
  assert.equal(CHECKS_INITIAL_DELAY_MS, 1000);
  assert.equal(CHECKS_MAX_DELAY_MS, 60_000);
});

test('checks polling: single pass immediately → no sleep, returns success', async () => {
  const { run, calls } = makeRunShim([{ stdout: checksJson('pass') }]);
  const { sleep, records } = makeTimingSleep();
  const client = new GitHubClient('/tmp/repo', run, sleep);

  assert.equal(await client.waitForChecks(5), 'success');
  assert.equal(calls.length, 1);
  assert.equal(records.length, 0);
});

test('CiFailed thrown when checks bucket=fail, no sleep before error', async () => {
  // First poll pending (one sleep), then fail
  const replies: CannedReply[] = [
    { stdout: checksJson('pending') },
    { stdout: checksJson('fail'), exitCode: 8 },
  ];
  const { run } = makeRunShim(replies);
  const { sleep, records } = makeTimingSleep();
  const client = new GitHubClient('/tmp/repo', run, sleep);

  await assert.rejects(
    () => client.waitForChecks(9),
    (err) => err instanceof CiFailed && /ci=fail/i.test(err.message),
  );
  // One sleep between the two polls, no further sleep after failure
  assert.equal(records.length, 1);
  assert.equal(records[0]?.delay, CHECKS_INITIAL_DELAY_MS);
});

test('MergeConflict thrown when gh pr merge emits conflict message', async () => {
  const replies: CannedReply[] = [
    {
      exitCode: 1,
      stderr: 'failed to merge: pull request is not mergeable: merge conflict detected',
    },
  ];
  const { run } = makeRunShim(replies);
  const client = new GitHubClient('/tmp/repo', run);

  await assert.rejects(() => client.mergePr(42, 'squash'), MergeConflict);
});

test('thread pagination: extra comments page fetched for unresolved thread only', async () => {
  const metaReply: CannedReply = { stdout: JSON.stringify(cannedMeta) };
  const threadsReply: CannedReply = {
    stdout: threadsJson({ unresolvedCount: 1, paginated: true }),
  };
  const extraCommentsReply: CannedReply = { stdout: extraCommentsJson(['IC_extra1', 'IC_extra2']) };

  const { run, calls } = makeRunShim([metaReply, threadsReply, extraCommentsReply]);
  const client = new GitHubClient('/tmp/repo', run);

  const threads = await client.listUnresolvedThreads(42);
  assert.equal(threads.length, 1);
  // First comment from initial page + two from pagination
  assert.equal(threads[0]?.comments.length, 3);
  assert.equal(threads[0]?.comments[0]?.id, 'IC_0');
  assert.equal(threads[0]?.comments[1]?.id, 'IC_extra1');
  assert.equal(threads[0]?.comments[2]?.id, 'IC_extra2');

  // Third call is the paginated comments fetch with the cursor
  const commentCallArgs = calls[2]?.args ?? [];
  assert.equal(commentCallArgs[0], 'api');
  assert.equal(commentCallArgs[1], 'graphql');
  // Verify cursor forwarded
  const cursorIdx = commentCallArgs.indexOf('-f', commentCallArgs.indexOf('commentsCursor'));
  const kvPair = commentCallArgs.find((v) => v.startsWith('commentsCursor='));
  assert.equal(kvPair, 'commentsCursor=cursor-next');

  assert.equal(calls.length, 3);
});

test('createPr with draft flag and custom labels', async () => {
  const replies: CannedReply[] = [
    { stdout: 'https://github.com/org/repo/pull/7\n' },
    { stdout: JSON.stringify({ ...cannedPr, number: 7 }) },
  ];
  const { run, calls } = makeRunShim(replies);
  const client = new GitHubClient('/tmp/repo', run);

  const pr = await client.createPr({
    title: 'chore: scaffold',
    body: 'scaffolding',
    base: 'main',
    head: 'feat/scaffold',
    draft: true,
    labels: ['custom-label'],
  });

  assert.equal(pr.number, 7);
  const args = calls[0]?.args ?? [];
  assert.ok(args.includes('--draft'));
  assert.ok(args.includes('custom-label'));
  assert.ok(!args.includes(DEFAULT_PR_LABEL));
});

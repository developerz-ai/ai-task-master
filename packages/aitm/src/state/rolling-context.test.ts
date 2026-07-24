import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrGroup } from '../domain/pr-group.ts';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';
import type { PullRequest } from '../github/schema.ts';
import { appendGroupDigest, ROLLING_CONTEXT_MAX_BYTES } from './rolling-context.ts';

function group(id: string, title: string): PrGroup {
  return { id, title, tasks: [], dependsOn: [], branch: `aitm/${id}`, pr: null, status: 'pending' };
}

function pr(number: number): PullRequest {
  return {
    number,
    state: 'OPEN',
    url: `https://github.com/o/r/pull/${number}`,
    headRefName: 'aitm/x',
    baseRefName: 'main',
  };
}

function delivery(over: Partial<WorkerDelivery> = {}): WorkerDelivery {
  return {
    branch: 'aitm/auth',
    draftCommitMessage: 'feat: auth',
    changes: [
      { path: 'src/user.ts', kind: 'create', summary: 'adds User model' },
      { path: 'src/db.ts', kind: 'modify', summary: 'wires the table' },
    ],
    progressEntries: ['- add auth models'],
    ...over,
  };
}

test('appendGroupDigest to an empty string yields a single block in the spec format', () => {
  const out = appendGroupDigest('', {
    group: group('auth', 'Auth models'),
    pr: pr(7),
    delivery: delivery(),
  });
  assert.equal(
    out,
    [
      'PR #7 — Auth models (group auth, branch aitm/auth)',
      '- create src/user.ts: adds User model',
      '- modify src/db.ts: wires the table',
      '- add auth models',
    ].join('\n'),
  );
});

test('appendGroupDigest separates blocks with a blank line (newest last)', () => {
  const first = appendGroupDigest('', {
    group: group('a', 'A'),
    pr: pr(1),
    delivery: delivery({ branch: 'aitm/a' }),
  });
  const both = appendGroupDigest(first, {
    group: group('b', 'B'),
    pr: pr(2),
    delivery: delivery({ branch: 'aitm/b' }),
  });
  assert.ok(both.startsWith(first), 'earlier block preserved verbatim at the front');
  assert.equal(both.split('\n\n').length, 2, 'two blocks');
  assert.ok(both.includes('PR #2 — B (group b, branch aitm/b)'));
  assert.ok(both.indexOf('PR #1') < both.indexOf('PR #2'), 'newest last');
});

test('renderBlock collapses interior blank lines so a block never contains the separator', () => {
  // LLM-authored summary / progress text can carry an embedded blank line; if it survived, the
  // "\n\n" would masquerade as a block boundary and capOldestFirst() would split mid-group.
  const first = appendGroupDigest('', {
    group: group('a', 'A'),
    pr: pr(1),
    delivery: delivery({
      branch: 'aitm/a',
      changes: [{ path: 'f.ts', kind: 'modify', summary: 'line one\n\nline two' }],
      progressEntries: ['- note one\n\n\n- note two'],
    }),
  });
  assert.ok(!first.includes('\n\n'), 'a single block carries no internal separator');
  const both = appendGroupDigest(first, {
    group: group('b', 'B'),
    pr: pr(2),
    delivery: delivery({ branch: 'aitm/b' }),
  });
  assert.equal(both.split('\n\n').length, 2, 'still exactly two whole blocks after a real join');
  assert.ok(both.startsWith(first), 'the normalized first block is preserved verbatim');
});

test('FIFO cap: appending past the budget drops OLDEST whole blocks first, never splitting one', () => {
  // Each block ~2 KB (a fat summary). Five blocks would be ~10 KB > 8 KB cap.
  const fat = 'x'.repeat(2000);
  let ctx = '';
  for (let i = 1; i <= 5; i++) {
    ctx = appendGroupDigest(ctx, {
      group: group(`g${i}`, `G${i}`),
      pr: pr(i),
      delivery: delivery({
        branch: `aitm/g${i}`,
        changes: [{ path: 'f.ts', kind: 'modify', summary: fat }],
      }),
    });
  }
  assert.ok(new TextEncoder().encode(ctx).length <= ROLLING_CONTEXT_MAX_BYTES, 'within cap');
  // The oldest (g1) is dropped; the newest (g5) is retained; no block is split.
  assert.ok(!ctx.includes('PR #1 — G1'), 'oldest dropped');
  assert.ok(ctx.includes('PR #5 — G5'), 'newest retained');
  for (const block of ctx.split('\n\n')) {
    assert.match(block, /^PR #\d+ — /, 'every retained block is whole (starts with its header)');
  }
});

test('FIFO cap: a single block larger than the cap is kept alone (bounds accumulation, never truncates)', () => {
  const huge = 'y'.repeat(ROLLING_CONTEXT_MAX_BYTES + 1000);
  const out = appendGroupDigest('', {
    group: group('big', 'Big'),
    pr: pr(9),
    delivery: delivery({ changes: [{ path: 'f.ts', kind: 'modify', summary: huge }] }),
  });
  assert.ok(
    new TextEncoder().encode(out).length > ROLLING_CONTEXT_MAX_BYTES,
    'the newest block is not truncated',
  );
  assert.ok(out.includes(huge), 'content intact');
  assert.ok(out.startsWith('PR #9 — Big'));
});

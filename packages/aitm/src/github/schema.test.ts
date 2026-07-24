import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CheckStatusSchema,
  PrStateSchema,
  PullRequestSchema,
  ReviewCommentSchema,
  ReviewThreadSchema,
} from './schema.ts';

test('PrStateSchema accepts OPEN/CLOSED/MERGED, rejects anything else', () => {
  for (const state of ['OPEN', 'CLOSED', 'MERGED']) {
    assert.equal(PrStateSchema.parse(state), state);
  }
  assert.throws(() => PrStateSchema.parse('open'));
  assert.throws(() => PrStateSchema.parse('DRAFT'));
});

test('PullRequestSchema parses a real gh pr view shape', () => {
  const raw = {
    number: 42,
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/42',
    headRefName: 'feature/foo',
    baseRefName: 'main',
  };
  assert.deepEqual(PullRequestSchema.parse(raw), raw);
});

test('PullRequestSchema rejects a non-positive or non-integer number', () => {
  const base = {
    state: 'OPEN',
    url: 'https://github.com/org/repo/pull/1',
    headRefName: 'feature/foo',
    baseRefName: 'main',
  };
  assert.throws(() => PullRequestSchema.parse({ ...base, number: 0 }));
  assert.throws(() => PullRequestSchema.parse({ ...base, number: -1 }));
  assert.throws(() => PullRequestSchema.parse({ ...base, number: 1.5 }));
});

test('PullRequestSchema rejects a malformed url', () => {
  assert.throws(() =>
    PullRequestSchema.parse({
      number: 1,
      state: 'OPEN',
      url: 'not-a-url',
      headRefName: 'feature/foo',
      baseRefName: 'main',
    }),
  );
});

test("CheckStatusSchema accepts every domain status, rejects gh's own bucket names", () => {
  for (const status of ['pending', 'success', 'failure', 'cancelled', 'skipped']) {
    assert.equal(CheckStatusSchema.parse(status), status);
  }
  // These are gh's wire-level bucket names (checks-poller.ts's BUCKET_TO_STATUS maps them) — the
  // schema itself must not accept them directly, or a mapping bug would go uncaught.
  assert.throws(() => CheckStatusSchema.parse('pass'));
  assert.throws(() => CheckStatusSchema.parse('fail'));
  assert.throws(() => CheckStatusSchema.parse('cancel'));
  assert.throws(() => CheckStatusSchema.parse('skipping'));
});

test('ReviewCommentSchema parses id/body/author', () => {
  const raw = { id: 'IC_1', body: 'please fix', author: 'reviewer' };
  assert.deepEqual(ReviewCommentSchema.parse(raw), raw);
});

test('ReviewThreadSchema parses a resolved thread with comments, path nullable', () => {
  const raw = {
    id: 'PRRT_1',
    isResolved: true,
    path: null,
    comments: [{ id: 'IC_1', body: 'general comment', author: 'ghost' }],
  };
  assert.deepEqual(ReviewThreadSchema.parse(raw), raw);
});

test('ReviewThreadSchema rejects a missing isResolved field', () => {
  assert.throws(() => ReviewThreadSchema.parse({ id: 'PRRT_1', path: null, comments: [] }));
});

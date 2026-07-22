import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunStep } from '../observability/step-progress.ts';
import { makeProgressTee, progressFileEntry } from './progress-file.ts';

const fixedNow = (): Date => new Date('2026-07-21T21:46:29.000Z');

test('progressFileEntry: renders timestamp, step tag, and full message', () => {
  const step: RunStep = { phase: 'working', unit: 'group', index: 1, total: 5 };
  assert.equal(
    progressFileEntry('group g1: worker starting', step, fixedNow),
    '- 2026-07-21T21:46:29.000Z [group 1/5 working] group g1: worker starting',
  );
});

test('progressFileEntry: omits the bracket when there is no step', () => {
  assert.equal(
    progressFileEntry('plan ready: 5 PR group(s)', undefined, fixedNow),
    '- 2026-07-21T21:46:29.000Z plan ready: 5 PR group(s)',
  );
});

test('progressFileEntry: an empty step renders without a bracket', () => {
  assert.equal(progressFileEntry('msg', {}, fixedNow), '- 2026-07-21T21:46:29.000Z msg');
});

test('makeProgressTee: emits to the console sink and appends the rendered entry', async () => {
  const emitted: Array<{ message: string; step?: RunStep }> = [];
  const appended: string[] = [];
  const tee = makeProgressTee({
    append: async (entry) => {
      appended.push(entry);
    },
    emit: (message, step) => emitted.push(step ? { message, step } : { message }),
    now: fixedNow,
  });

  const step: RunStep = { phase: 'waiting-ci', unit: 'group', index: 2, total: 5 };
  tee('group g2: PR #7 opened', step);
  await Promise.resolve();

  assert.deepEqual(emitted, [{ message: 'group g2: PR #7 opened', step }]);
  assert.deepEqual(appended, [
    '- 2026-07-21T21:46:29.000Z [group 2/5 waiting-ci] group g2: PR #7 opened',
  ]);
});

test('makeProgressTee: without append it only emits', () => {
  const emitted: string[] = [];
  const tee = makeProgressTee({ emit: (message) => emitted.push(message) });
  tee('console-only line');
  assert.deepEqual(emitted, ['console-only line']);
});

test('makeProgressTee: a rejecting append never breaks the emit path', async () => {
  const emitted: string[] = [];
  const tee = makeProgressTee({
    append: () => Promise.reject(new Error('disk full')),
    emit: (message) => emitted.push(message),
    now: fixedNow,
  });
  tee('first');
  tee('second');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(emitted, ['first', 'second']);
});

test('makeProgressTee: a synchronously-throwing append never breaks the emit path', () => {
  const emitted: string[] = [];
  const tee = makeProgressTee({
    append: () => {
      throw new Error('sync boom');
    },
    emit: (message) => emitted.push(message),
    now: fixedNow,
  });
  tee('still emitted');
  assert.deepEqual(emitted, ['still emitted']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mutex } from './mutex.ts';

// A deferred promise so a section can be held open mid-flight to prove the next one is blocked.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('Mutex: sections never overlap — a second waits for the first to settle', async () => {
  const mutex = new Mutex();
  const events: string[] = [];
  const first = deferred();

  const a = mutex.runExclusive(async () => {
    events.push('a:start');
    await first.promise;
    events.push('a:end');
  });
  const b = mutex.runExclusive(async () => {
    events.push('b:start');
  });

  // b must not have started while a holds the lock.
  await Promise.resolve();
  assert.deepEqual(events, ['a:start'], 'b is blocked until a settles');

  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start']);
});

test('Mutex: preserves call order (FIFO) across many sections', async () => {
  const mutex = new Mutex();
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 5 }, (_unused, i) =>
      mutex.runExclusive(async () => {
        order.push(i);
      }),
    ),
  );
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('Mutex: returns the section value to its caller', async () => {
  const mutex = new Mutex();
  const value = await mutex.runExclusive(async () => 42);
  assert.equal(value, 42);
});

test('Mutex: a rejecting section rejects its own caller but does not wedge later sections', async () => {
  const mutex = new Mutex();
  const failing = mutex.runExclusive(async () => {
    throw new Error('boom');
  });
  await assert.rejects(failing, /boom/);

  // The chain recovered: a subsequent section still runs.
  const after = await mutex.runExclusive(async () => 'ok');
  assert.equal(after, 'ok');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPool } from './pool.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const isAbortError = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';

test('pool: maps items to results in input order and passes the index', async () => {
  const out = await runPool([10, 20, 30], 2, async (item, index) => item + index);
  assert.deepEqual(out, [10, 21, 32]);
});

test('pool: empty items → empty array, worker never called', async () => {
  let calls = 0;
  const out = await runPool<number, number>([], 4, async (n) => {
    calls += 1;
    return n;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test('pool: never runs more than `limit` workers at once → cap honored', async () => {
  let active = 0;
  let peak = 0;
  const worker = async (n: number): Promise<number> => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
    return n * 2;
  };
  const out = await runPool([0, 1, 2, 3, 4, 5, 6], 3, worker);
  assert.equal(peak, 3);
  assert.deepEqual(out, [0, 2, 4, 6, 8, 10, 12]);
});

test('pool: limit larger than item count → caps at item count', async () => {
  let active = 0;
  let peak = 0;
  const worker = async (n: number): Promise<number> => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
    return n;
  };
  const out = await runPool([0, 1], 10, worker);
  assert.equal(peak, 2);
  assert.deepEqual(out, [0, 1]);
});

test('pool: a non-positive limit is clamped to 1 (runs serially, never stalls)', async () => {
  let active = 0;
  let peak = 0;
  const worker = async (n: number): Promise<number> => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(2);
    active -= 1;
    return n;
  };
  const out = await runPool([0, 1, 2], 0, worker);
  assert.equal(peak, 1);
  assert.deepEqual(out, [0, 1, 2]);
});

test('pool: a fractional limit is floored', async () => {
  assert.deepEqual(await runPool([0, 1, 2], 1.9, async (n) => n), [0, 1, 2]);
  assert.deepEqual(await runPool([0, 1, 2], -5, async (n) => n), [0, 1, 2]);
});

test('pool: a worker rejection rejects the pool and stops launching new work', async () => {
  const started: number[] = [];
  const boom = new Error('boom');
  const worker = async (n: number): Promise<number> => {
    started.push(n);
    if (n === 1) throw boom;
    await sleep(2);
    return n;
  };
  await assert.rejects(
    () => runPool([0, 1, 2, 3], 1, worker),
    (e: unknown) => e === boom,
  );
  assert.deepEqual(started, [0, 1]);
});

test('pool: rejection under concurrency launches no items past the failing batch', async () => {
  const started: number[] = [];
  const release = deferred<void>();
  const boom = new Error('nope');
  const worker = async (n: number): Promise<number> => {
    started.push(n);
    if (n === 0) throw boom;
    await release.promise;
    return n;
  };
  const running = runPool([0, 1, 2, 3], 2, worker);
  await assert.rejects(running, (e: unknown) => e === boom);
  assert.deepEqual(started, [0, 1]);
  release.resolve();
  await tick();
  assert.deepEqual(started, [0, 1]);
});

test('pool: an already-aborted signal → rejects without running any worker', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const started: number[] = [];
  const worker = async (n: number): Promise<number> => {
    started.push(n);
    return n;
  };
  await assert.rejects(
    () => runPool([0, 1, 2], 2, worker, { signal: controller.signal }),
    (e: unknown) => e instanceof Error && e.message === 'cancelled',
  );
  assert.deepEqual(started, []);
});

test('pool: aborting mid-flight → rejects promptly with the reason, launches no new workers', async () => {
  const controller = new AbortController();
  const started: number[] = [];
  const release = deferred<void>();
  const worker = async (n: number): Promise<number> => {
    started.push(n);
    await release.promise;
    return n;
  };
  const running = runPool([0, 1, 2, 3], 2, worker, { signal: controller.signal });
  await tick();
  controller.abort(new Error('stop'));
  await assert.rejects(running, (e: unknown) => e instanceof Error && e.message === 'stop');
  assert.deepEqual(started, [0, 1]);
  release.resolve();
});

test('pool: abort with no explicit reason → rejects with an AbortError', async () => {
  const controller = new AbortController();
  const release = deferred<void>();
  const worker = async (n: number): Promise<number> => {
    await release.promise;
    return n;
  };
  const running = runPool([0, 1], 1, worker, { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(running, isAbortError);
  release.resolve();
});

test('pool: aborting after completion is a no-op (listener removed, no late rejection)', async () => {
  const controller = new AbortController();
  const out = await runPool([0, 1], 2, async (n) => n, { signal: controller.signal });
  assert.deepEqual(out, [0, 1]);
  controller.abort(new Error('too late'));
  await tick();
});

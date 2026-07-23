import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Disposer } from './disposer.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('disposer: disposeAll releases newest first (LIFO)', async () => {
  const disposer = new Disposer();
  const order: string[] = [];

  disposer.add(() => {
    order.push('first');
  });
  disposer.add(() => {
    order.push('second');
  });
  disposer.add(() => {
    order.push('third');
  });

  await disposer.disposeAll();
  assert.deepEqual(order, ['third', 'second', 'first']);
});

test('disposer: async disposers are awaited one at a time → no overlap', async () => {
  const disposer = new Disposer();
  const events: string[] = [];

  disposer.add(async () => {
    events.push('a:start');
    await tick();
    events.push('a:end');
  });
  disposer.add(async () => {
    events.push('b:start');
    await tick();
    events.push('b:end');
  });

  await disposer.disposeAll();
  assert.deepEqual(events, ['b:start', 'b:end', 'a:start', 'a:end']);
});

test('disposer: a throwing disposer does not stop the rest → AggregateError carries every failure', async () => {
  const disposer = new Disposer();
  const released: string[] = [];
  const syncBoom = new Error('sync boom');
  const asyncBoom = new Error('async boom');

  disposer.add(() => {
    released.push('bottom');
  });
  disposer.add(() => {
    throw syncBoom;
  });
  disposer.add(async () => {
    throw asyncBoom;
  });
  disposer.add(() => {
    released.push('top');
  });

  await assert.rejects(disposer.disposeAll(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [asyncBoom, syncBoom]);
    assert.match(error.message, /2 disposer\(s\) failed/);
    return true;
  });
  assert.deepEqual(
    released,
    ['top', 'bottom'],
    'disposers on both sides of the throwers still ran',
  );
});

test('disposer: disposeAll is idempotent → each disposer runs at most once', async () => {
  const disposer = new Disposer();
  let calls = 0;

  disposer.add(() => {
    calls += 1;
  });

  await disposer.disposeAll();
  await disposer.disposeAll();
  await disposer.disposeAll();
  assert.equal(calls, 1);
});

test('disposer: a resource registered mid-drain is still released', async () => {
  const disposer = new Disposer();
  const released: string[] = [];

  disposer.add(async () => {
    released.push('early');
    await tick();
    disposer.add(() => {
      released.push('late');
    });
  });

  await disposer.disposeAll();
  assert.deepEqual(released, ['early', 'late']);
});

test('disposer: concurrent disposeAll calls settle after teardown, running each disposer once', async () => {
  const disposer = new Disposer();
  let calls = 0;
  let done = false;

  disposer.add(async () => {
    calls += 1;
    await tick();
    done = true;
  });

  const first = disposer.disposeAll();
  const second = disposer.disposeAll();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.ok(done, 'both callers waited for the in-flight teardown');
});

test('disposer: a failing drain does not wedge later disposeAll calls', async () => {
  const disposer = new Disposer();
  const released: string[] = [];

  disposer.add(() => {
    throw new Error('boom');
  });
  await assert.rejects(disposer.disposeAll(), AggregateError);

  disposer.add(() => {
    released.push('after');
  });
  await disposer.disposeAll();
  assert.deepEqual(released, ['after']);
});

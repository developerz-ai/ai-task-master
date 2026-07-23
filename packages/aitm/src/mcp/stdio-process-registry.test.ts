import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ExitHooks, type KillFn, StdioProcessRegistry } from './stdio-process-registry.ts';

type Signalled = { pid: number; signal: NodeJS.Signals | 0 };

// A fake process table: `alive` holds the pids that still exist, and every signal is recorded.
// SIGKILL removes the pid; SIGTERM only does so when the pid is in `respectsTerm`.
function fakeOs(
  alive: number[],
  respectsTerm: readonly number[] = alive,
): {
  kill: KillFn;
  signals: Signalled[];
  alive: Set<number>;
} {
  const live = new Set(alive);
  const signals: Signalled[] = [];
  const kill: KillFn = (pid, signal) => {
    if (!live.has(pid)) {
      const err: NodeJS.ErrnoException = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    }
    if (signal === 0) return;
    signals.push({ pid, signal });
    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && respectsTerm.includes(pid))) {
      live.delete(pid);
    }
  };
  return { kill, signals, alive: live };
}

function fakeExitHooks(): ExitHooks & { listeners: Array<() => void> } {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    on(_event, listener) {
      listeners.push(listener);
      return this;
    },
    off(_event, listener) {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
      return this;
    },
  };
}

test('terminate: SIGTERMs a live child and does not escalate when it exits', async () => {
  const os = fakeOs([4242]);
  const registry = new StdioProcessRegistry({
    kill: os.kill,
    graceMs: 200,
    exitHooks: fakeExitHooks(),
  });
  registry.register('ui-debugger', 4242);
  await registry.terminate();
  assert.deepEqual(os.signals, [{ pid: 4242, signal: 'SIGTERM' }]);
  assert.equal(os.alive.has(4242), false);
});

test('terminate: escalates to SIGKILL for a child that ignores SIGTERM', async () => {
  const os = fakeOs([7], []);
  const registry = new StdioProcessRegistry({
    kill: os.kill,
    graceMs: 100,
    exitHooks: fakeExitHooks(),
  });
  registry.register('stubborn', 7);
  await registry.terminate();
  assert.deepEqual(os.signals, [
    { pid: 7, signal: 'SIGTERM' },
    { pid: 7, signal: 'SIGKILL' },
  ]);
  assert.equal(os.alive.has(7), false);
});

test('terminate: a child that already exited is never signalled', async () => {
  const os = fakeOs([]);
  const registry = new StdioProcessRegistry({
    kill: os.kill,
    graceMs: 50,
    exitHooks: fakeExitHooks(),
  });
  registry.register('gone', 99);
  await registry.terminate();
  assert.deepEqual(os.signals, []);
});

test('terminate: clears the registry so a second call is a no-op', async () => {
  const os = fakeOs([5], []);
  const registry = new StdioProcessRegistry({
    kill: os.kill,
    graceMs: 0,
    exitHooks: fakeExitHooks(),
  });
  registry.register('a', 5);
  await registry.terminate();
  const afterFirst = os.signals.length;
  await registry.terminate();
  assert.equal(os.signals.length, afterFirst, 'nothing is signalled twice');
  assert.deepEqual(registry.list(), []);
});

test('terminate: one failing kill does not stop the others', async () => {
  const os = fakeOs([1, 2], []);
  const kill: KillFn = (pid, signal) => {
    if (pid === 1 && signal === 'SIGTERM') throw new Error('boom');
    os.kill(pid, signal);
  };
  const registry = new StdioProcessRegistry({ kill, graceMs: 0, exitHooks: fakeExitHooks() });
  registry.register('a', 1);
  registry.register('b', 2);
  await registry.terminate();
  assert.ok(
    os.signals.some((s) => s.pid === 2 && s.signal === 'SIGKILL'),
    'the second child is still reaped',
  );
});

test('exit guard: registering arms one exit listener, terminate removes it', async () => {
  const hooks = fakeExitHooks();
  const os = fakeOs([11, 12]);
  const registry = new StdioProcessRegistry({ kill: os.kill, graceMs: 50, exitHooks: hooks });
  registry.register('a', 11);
  registry.register('b', 12);
  assert.equal(hooks.listeners.length, 1, 'exactly one guard, however many children');
  await registry.terminate();
  assert.equal(hooks.listeners.length, 0, 'guard removed once the children are reaped');
});

test('exit guard: firing on process exit SIGKILLs every tracked child', () => {
  const hooks = fakeExitHooks();
  const os = fakeOs([21, 22], []);
  const registry = new StdioProcessRegistry({ kill: os.kill, exitHooks: hooks });
  registry.register('a', 21);
  registry.register('b', 22);
  const guard = hooks.listeners[0];
  assert.ok(guard, 'a guard was installed');
  guard();
  assert.deepEqual(os.signals, [
    { pid: 21, signal: 'SIGKILL' },
    { pid: 22, signal: 'SIGKILL' },
  ]);
  assert.deepEqual(registry.list(), []);
});

test('killAllNow: a process we may not signal (EPERM) still counts as alive', () => {
  const signals: Signalled[] = [];
  const kill: KillFn = (pid, signal) => {
    if (signal === 0) {
      const err: NodeJS.ErrnoException = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
    signals.push({ pid, signal });
  };
  const registry = new StdioProcessRegistry({ kill, exitHooks: fakeExitHooks() });
  registry.register('root-owned', 31);
  registry.killAllNow();
  assert.deepEqual(signals, [{ pid: 31, signal: 'SIGKILL' }]);
});

test('list: exposes tracked children until they are reaped', () => {
  const registry = new StdioProcessRegistry({ kill: () => {}, exitHooks: fakeExitHooks() });
  registry.register('ui-debugger', 100);
  assert.deepEqual(registry.list(), [{ name: 'ui-debugger', pid: 100 }]);
});

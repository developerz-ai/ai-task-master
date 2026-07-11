import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  backgroundProcessTools,
  ProcessManager,
  type ProcessStatus,
  type SpawnFn,
} from './background-process.ts';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// True once `pid` no longer exists (signal-0 probe throws ESRCH).
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

// Run a test body with a manager whose processes are force-killed in `finally` — a failed assertion
// or timeout must never leave a detached process (or its group) alive to disturb later tests.
async function withManager(
  init: Omit<ConstructorParameters<typeof ProcessManager>[0], 'cwd'>,
  fn: (mgr: ProcessManager) => Promise<void>,
): Promise<void> {
  const dir = await tempDir();
  const mgr = new ProcessManager({ cwd: dir.path, ...init });
  try {
    await fn(mgr);
  } finally {
    mgr.killAll('SIGKILL');
    await dir.cleanup();
  }
}

async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'compat-bg-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

// Poll until `predicate` holds or the budget runs out — avoids racing on async process events.
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('ProcessManager: captures output, reports exit, and reads incrementally', async () => {
  const dir = await tempDir();
  try {
    const mgr = new ProcessManager({ cwd: dir.path });
    const { id } = mgr.start('echo hello; echo world');
    await until(() => mgr.list()[0]?.running === false);

    // First read after exit returns everything produced so far.
    const first = mgr.output(id);
    assert.match(first?.stdout ?? '', /hello/);
    assert.match(first?.stdout ?? '', /world/);
    assert.equal(first?.running, false);
    assert.equal(first?.exitCode, 0);

    // Second read sees no new bytes — the cursor advanced.
    assert.equal(mgr.output(id)?.stdout, '');
  } finally {
    await dir.cleanup();
  }
});

test('ProcessManager: non-zero exit code is recorded', async () => {
  const dir = await tempDir();
  try {
    const mgr = new ProcessManager({ cwd: dir.path });
    const { id } = mgr.start('exit 3');
    await until(() => mgr.output(id)?.running === false);
    assert.equal(mgr.output(id)?.exitCode, 3);
  } finally {
    await dir.cleanup();
  }
});

test('ProcessManager: kill stops a long-running process', async () => {
  const dir = await tempDir();
  try {
    const mgr = new ProcessManager({ cwd: dir.path });
    const { id, running } = mgr.start('sleep 30');
    assert.equal(running, true);
    assert.equal(mgr.kill(id), true);
    await until(() => mgr.output(id)?.running === false);
    assert.equal(mgr.output(id)?.running, false);
    // Killing again (already exited) is idempotent — still true.
    assert.equal(mgr.kill(id), true);
  } finally {
    await dir.cleanup();
  }
});

test('ProcessManager: kill of unknown id returns false; output of unknown id is null', async () => {
  const dir = await tempDir();
  try {
    const mgr = new ProcessManager({ cwd: dir.path });
    assert.equal(mgr.kill('nope'), false);
    assert.equal(mgr.output('nope'), null);
  } finally {
    await dir.cleanup();
  }
});

test('ProcessManager: killAll stops every running process', async () => {
  const dir = await tempDir();
  try {
    const mgr = new ProcessManager({ cwd: dir.path });
    const a = mgr.start('sleep 30');
    const b = mgr.start('sleep 30');
    mgr.killAll();
    await until(() => mgr.output(a.id)?.running === false && mgr.output(b.id)?.running === false);
    assert.equal(
      mgr.list().every((p) => !p.running),
      true,
    );
  } finally {
    await dir.cleanup();
  }
});

test('ProcessManager: output cap drops the front and flags truncation', async () => {
  const dir = await tempDir();
  try {
    const mgr = new ProcessManager({ cwd: dir.path, maxBufferBytes: 64 });
    // Print ~300 bytes; only the last 64 are retained. Poll via list() so we do not consume the
    // buffer before the single read below (output() advances the read cursor).
    const { id } = mgr.start('for i in $(seq 1 100); do printf "ABC"; done');
    await until(() => mgr.list()[0]?.running === false);
    const out = mgr.output(id);
    assert.equal(out?.truncated, true);
    assert.ok((out?.stdout.length ?? 0) <= 64);
  } finally {
    await dir.cleanup();
  }
});

async function callTool<I, O>(t: { execute?: unknown }, input: I): Promise<O> {
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('tool has no execute');
  return (await (exec as (i: I, o: { toolCallId: string; messages: never[] }) => Promise<O>)(
    input,
    { toolCallId: 'test', messages: [] },
  )) as O;
}

test('backgroundProcessTools: backgroundBash → bashOutput → killBash round-trip', async () => {
  const dir = await tempDir();
  try {
    const { manager, backgroundBash, bashOutput, killBash, listBackground } =
      backgroundProcessTools({ cwd: dir.path });
    const started = await callTool<{ command: string }, { id: string; running: boolean }>(
      backgroundBash,
      { command: 'sleep 30' },
    );
    assert.ok(started.id);
    assert.equal(started.running, true);

    const list = await callTool<Record<string, never>, { processes: Array<{ id: string }> }>(
      listBackground,
      {},
    );
    assert.equal(list.processes.length, 1);

    const killed = await callTool<{ id: string }, { killed: boolean }>(killBash, {
      id: started.id,
    });
    assert.equal(killed.killed, true);
    await until(() => manager.output(started.id)?.running === false);

    const out = await callTool<{ id: string }, { running: boolean }>(bashOutput, {
      id: started.id,
    });
    assert.equal(out.running, false);
  } finally {
    await dir.cleanup();
  }
});

test('backgroundProcessTools: bashOutput on a missing id is a graceful error, not a throw', async () => {
  const dir = await tempDir();
  try {
    const { bashOutput } = backgroundProcessTools({ cwd: dir.path });
    const out = await callTool<{ id: string }, { exitCode: number; stderr: string }>(bashOutput, {
      id: 'does-not-exist',
    });
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /no background process/);
  } finally {
    await dir.cleanup();
  }
});

// ---- process-group kill (issue #111) ----

// Read stdout incrementally until it has emitted a CHILD=<pid> marker; returns the captured pid.
async function childPidOf(mgr: ProcessManager, id: string): Promise<number> {
  let acc = '';
  await until(() => {
    acc += mgr.output(id)?.stdout ?? '';
    return /CHILD=(\d+)/.test(acc);
  });
  return Number(acc.match(/CHILD=(\d+)/)?.[1]);
}

test('ProcessManager: kill terminates the whole process group, not just bash', async () => {
  // Short grace so the (harmless, ESRCH) escalation timer resolves fast rather than lingering.
  await withManager({ killGraceMs: 100 }, async (mgr) => {
    // The backgrounded `sleep` is a child of bash; capture its pid so we can probe it directly.
    const { id } = mgr.start('sleep 100 & echo "CHILD=$!"; wait');
    const childPid = await childPidOf(mgr, id);
    assert.ok(childPid > 0);
    assert.equal(isGone(childPid), false, 'child alive before kill');

    assert.equal(mgr.kill(id), true);
    await until(() => mgr.output(id)?.running === false);
    // Group kill reaches the orphaned child too — fails against current main (single-pid kill).
    await until(() => isGone(childPid), 3000);
  });
});

test('ProcessManager: a SIGTERM-ignoring process is SIGKILLed after killGraceMs', async () => {
  // Wide grace vs a small probe delay → the "still alive within grace" check is not scheduler-racy.
  await withManager({ killGraceMs: 700 }, async (mgr) => {
    const { id } = mgr.start("trap '' TERM; echo READY; read _");
    await until(() => (mgr.output(id)?.stdout ?? '').includes('READY'));

    mgr.kill(id);
    // Comfortably inside the 700 ms grace: SIGTERM is ignored and the process is still alive.
    await delay(150);
    assert.equal(mgr.output(id)?.running, true, 'SIGTERM ignored within grace');
    // Escalation SIGKILL (uncatchable) then takes it down.
    await until(() => mgr.output(id)?.running === false, 3000);
    const status = mgr.list()[0];
    assert.equal(status?.running, false);
    assert.notEqual(status?.exitCode, null);
  });
});

test('ProcessManager: escalation still SIGKILLs a TERM-ignoring child after its shell exits', async () => {
  // The subshell traps TERM and outlives bash (which exits on the same SIGTERM). Escalation must
  // stay armed on the group and reap the survivor — fails if the timer is cancelled on bash's exit.
  await withManager({ killGraceMs: 200 }, async (mgr) => {
    const { id } = mgr.start(`(trap '' TERM; sleep 100) & echo "CHILD=$!"; wait`);
    const childPid = await childPidOf(mgr, id);
    assert.ok(childPid > 0);

    mgr.kill(id);
    await until(() => mgr.output(id)?.running === false); // bash exits on SIGTERM
    await until(() => isGone(childPid), 3000); // the TERM-ignoring child dies on the group SIGKILL
  });
});

// ---- onExit callback (issue #111) ----

test('ProcessManager: onExit fires exactly once on a normal exit', async () => {
  const calls: Array<{ id: string; status: ProcessStatus }> = [];
  await withManager({ onExit: (id, status) => calls.push({ id, status }) }, async (mgr) => {
    const { id } = mgr.start('echo hi');
    await until(() => calls.length > 0);
    await delay(50); // window for an erroneous second fire
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.id, id);
    assert.equal(calls[0]?.status.running, false);
    assert.equal(calls[0]?.status.exitCode, 0);
  });
});

test('ProcessManager: onExit fires exactly once on a spawn failure', async () => {
  const calls: ProcessStatus[] = [];
  // Seam: spawn a nonexistent binary so the child emits `error` (ENOENT) and never `exit`.
  const badSpawn = ((_cmd: string, _args: readonly string[], opts: object) =>
    realSpawn('aitm-no-such-binary-xyz', [], opts)) as SpawnFn;
  await withManager(
    { onExit: (_id, status) => calls.push(status), spawn: badSpawn },
    async (mgr) => {
      mgr.start('irrelevant');
      await until(() => calls.length > 0);
      await delay(50);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.running, false);
      assert.notEqual(calls[0]?.exitCode, null);
    },
  );
});

test('ProcessManager: a throwing onExit callback does not break the manager', async () => {
  await withManager(
    {
      onExit: () => {
        throw new Error('callback boom');
      },
    },
    async (mgr) => {
      const { id } = mgr.start('echo hi');
      await until(() => mgr.output(id)?.running === false);
      // The manager is still usable — the throw was swallowed.
      assert.equal(mgr.list().length, 1);
    },
  );
});

// ---- bashOutput filter (issue #111) ----

test('ProcessManager: output filter returns only matching lines and consumes the cursor', async () => {
  await withManager({}, async (mgr) => {
    const { id } = mgr.start('printf "GET /\\nERROR boom\\nGET /x\\n"');
    // Poll running via list() so we do not consume the buffer before the filtered read.
    await until(() => mgr.list()[0]?.running === false);
    const filtered = mgr.output(id, 'ERROR');
    assert.equal(filtered?.stdout, 'ERROR boom');
    // The cursor advanced over the non-matching lines too — no re-delivery.
    assert.equal(mgr.output(id)?.stdout, '');
  });
});

test('ProcessManager: an invalid filter regex errors without advancing the cursor', async () => {
  await withManager({}, async (mgr) => {
    const { id } = mgr.start('printf "hello\\n"');
    await until(() => mgr.list()[0]?.running === false);
    const bad = mgr.output(id, '([');
    assert.match(bad?.stderr ?? '', /invalid filter regex/);
    assert.equal(bad?.stdout, '');
    // Cursor untouched — a valid read still returns the buffered output.
    assert.equal(mgr.output(id)?.stdout, 'hello\n');
  });
});

test('backgroundProcessTools: bashOutput passes the filter through', async () => {
  const dir = await tempDir();
  const { manager, bashOutput } = backgroundProcessTools({ cwd: dir.path });
  try {
    const { id } = manager.start('printf "keep me\\ndrop me\\n"');
    await until(() => manager.list()[0]?.running === false);
    const out = await callTool<{ id: string; filter: string }, { stdout: string }>(bashOutput, {
      id,
      filter: 'keep',
    });
    assert.equal(out.stdout, 'keep me');
  } finally {
    manager.killAll('SIGKILL');
    await dir.cleanup();
  }
});

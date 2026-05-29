import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backgroundProcessTools, ProcessManager } from './background-process.ts';

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

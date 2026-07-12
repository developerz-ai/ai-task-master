import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMemoryIndex } from '@developerz.ai/ai-claude-compat';
import { buildMemoryTool, type MemoryToolInput } from './memory-tool.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aitm-memtool-'));
}

function run(tool: ReturnType<typeof buildMemoryTool>, input: MemoryToolInput): Promise<string> {
  const exec = tool.execute;
  assert.equal(typeof exec, 'function');
  return (exec as (i: MemoryToolInput, o: unknown) => Promise<string>)(input, {
    toolCallId: 'c',
    messages: [],
  });
}

test('memory tool write → read → remove round-trips against the state dir', async () => {
  const dir = await tmp();
  try {
    const tool = buildMemoryTool(dir);
    const saved = await run(tool, {
      action: 'write',
      name: 'flaky-e2e',
      description: 'e2e flakes on cold cache — retry once',
      type: 'project',
      body: 'The e2e job fails ~1/5 on a cold Docker cache; re-run before assuming a break.',
    });
    assert.match(saved, /saved memory "flaky-e2e"/);
    assert.equal((await loadMemoryIndex(dir)).length, 1, 'index updated in the same op');

    const read = await run(tool, { action: 'read', name: 'flaky-e2e' });
    assert.match(read, /flaky-e2e \(project\)/);
    assert.match(read, /cold Docker cache/);

    const removed = await run(tool, { action: 'remove', name: 'flaky-e2e' });
    assert.match(removed, /removed memory "flaky-e2e"/);
    assert.deepEqual(await loadMemoryIndex(dir), [], 'index line removed too');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('memory tool read of a missing memory returns a not-found line, not a throw', async () => {
  const dir = await tmp();
  try {
    const out = await run(buildMemoryTool(dir), { action: 'read', name: 'nope' });
    assert.match(out, /no memory named "nope"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('memory tool write without a body reports the requirement instead of writing', async () => {
  const dir = await tmp();
  try {
    const out = await run(buildMemoryTool(dir), {
      action: 'write',
      name: 'x',
      description: 'd',
    });
    assert.match(out, /needs both a description and a body/);
    assert.deepEqual(await loadMemoryIndex(dir), [], 'nothing written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

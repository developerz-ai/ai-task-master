import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { DEFAULT_STEP_OUTPUT_BUDGET_CHARS, withStepOutputBudget } from './step-output-budget.ts';
import { ToolOutputStore } from './tool-output-store.ts';

async function tempStore(): Promise<{
  store: ToolOutputStore;
  dir: string;
  spillCount: () => Promise<number>;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'compat-step-budget-'));
  const dir = join(root, 'tool-output');
  return {
    store: new ToolOutputStore(dir),
    dir,
    // Files the store has actually spilled; a never-used store has no directory yet → 0.
    spillCount: async () =>
      (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.txt')).length,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// A tool whose model-visible text IS the string passed as `output`, so a test dials a result's size
// by the output it renders. execute is present but unused (toModelOutput is what the budget measures).
function echoTool(): Tool {
  return tool({
    description: 'echo',
    inputSchema: z.object({}),
    execute: async () => '',
    toModelOutput: ({ output }) => ({ type: 'text', value: String(output) }),
  }) as Tool;
}

// A tool with NO custom toModelOutput → the SDK default render (text for a string, json otherwise).
function defaultTool(): Tool {
  return tool({
    description: 'default',
    inputSchema: z.object({}),
    execute: async () => ({}),
  }) as Tool;
}

// Invoke a wrapped tool's decorated toModelOutput with a synthetic call, mirroring the SDK's
// sequential per-step render of one tool result.
async function render(t: Tool, output: unknown): Promise<{ type: string; value?: unknown }> {
  const fn = t.toModelOutput;
  if (typeof fn !== 'function') throw new Error('tool has no toModelOutput');
  return (await fn({ toolCallId: 'c', input: {}, output })) as { type: string; value?: unknown };
}

const NOTICE = /Full output saved to (\S+) — page with readFile\(offset\/limit\) or grep\]/;

test('step-output-budget: default budget constant is 120k chars', () => {
  assert.equal(DEFAULT_STEP_OUTPUT_BUDGET_CHARS, 120_000);
});

test('step-output-budget: a step under budget → every result shown verbatim, nothing spilled', async () => {
  const s = await tempStore();
  try {
    const { tools } = withStepOutputBudget(
      { echo: echoTool() },
      { store: s.store, budgetChars: 100 },
    );
    const a = await render(tools.echo, 'a'.repeat(40));
    const b = await render(tools.echo, 'b'.repeat(40));
    assert.equal(a.value, 'a'.repeat(40));
    assert.equal(b.value, 'b'.repeat(40));
    assert.equal(await s.spillCount(), 0, 'no result was spilled');
  } finally {
    await s.cleanup();
  }
});

test('step-output-budget: combined step output over budget → remaining results spill (full content paged)', async () => {
  const s = await tempStore();
  try {
    const { tools } = withStepOutputBudget(
      { echo: echoTool() },
      { store: s.store, budgetChars: 100 },
    );
    // Three parallel 60-char results in one step: 60, 120 (crosses), then 180.
    const first = await render(tools.echo, 'a'.repeat(60));
    const second = await render(tools.echo, 'b'.repeat(60));
    const third = await render(tools.echo, 'c'.repeat(60));

    // The first two are under/at the crossing → shown verbatim.
    assert.equal(first.value, 'a'.repeat(60));
    assert.equal(second.value, 'b'.repeat(60));
    // The third is past the budget → withheld, replaced by a paging notice.
    assert.equal(third.type, 'text');
    const notice = String(third.value);
    assert.match(notice, /output withheld/);
    assert.match(notice, /exceeded the 100-char budget/);
    const m = notice.match(NOTICE);
    assert.ok(m, `notice names the spill path + paging hint; got: ${notice}`);
    // The spilled file holds the third result in FULL, so the model can page it.
    assert.equal(await readFile(m[1] ?? '', 'utf8'), 'c'.repeat(60));
    assert.equal(await s.spillCount(), 1, 'only the over-budget result spilled');
  } finally {
    await s.cleanup();
  }
});

test('step-output-budget: the default 120k budget spills once the step total crosses it', async () => {
  const s = await tempStore();
  try {
    const { tools } = withStepOutputBudget({ echo: echoTool() }, { store: s.store });
    // 50k-char results: 50k, 100k, 150k (crosses 120k), then the fourth spills.
    for (let i = 0; i < 3; i++) {
      const shown = await render(tools.echo, 'x'.repeat(50_000));
      assert.equal(String(shown.value).length, 50_000, `result ${i} shown verbatim`);
    }
    const spilled = await render(tools.echo, 'y'.repeat(50_000));
    assert.match(String(spilled.value), NOTICE);
    assert.equal(await s.spillCount(), 1);
  } finally {
    await s.cleanup();
  }
});

test('step-output-budget: stepFinished resets the accumulator → next step starts fresh', async () => {
  const s = await tempStore();
  try {
    const { tools, stepFinished } = withStepOutputBudget(
      { echo: echoTool() },
      { store: s.store, budgetChars: 100 },
    );
    // Step 1: push over budget so a result spills.
    await render(tools.echo, 'a'.repeat(60));
    await render(tools.echo, 'b'.repeat(60));
    assert.match(String((await render(tools.echo, 'c'.repeat(60))).value), NOTICE);

    stepFinished();

    // Step 2: a fresh 60-char result is well under budget again → shown verbatim, not spilled.
    const next = await render(tools.echo, 'd'.repeat(60));
    assert.equal(next.value, 'd'.repeat(60));
    assert.equal(await s.spillCount(), 1, 'no new spill after the reset');
  } finally {
    await s.cleanup();
  }
});

test('step-output-budget: a spill write failure fails open → the result is shown, never thrown', async () => {
  const s = await tempStore();
  try {
    class FailingStore extends ToolOutputStore {
      override save(): Promise<never> {
        return Promise.reject(new Error('spill failed'));
      }
    }
    const { tools } = withStepOutputBudget(
      { echo: echoTool() },
      { store: new FailingStore(s.dir), budgetChars: 100 },
    );
    await render(tools.echo, 'a'.repeat(60));
    await render(tools.echo, 'b'.repeat(60));
    // Over budget, but the store rejects: degrade to showing the result in full (no data loss).
    const third = await render(tools.echo, 'c'.repeat(60));
    assert.equal(third.value, 'c'.repeat(60));
    assert.equal(await s.spillCount(), 0, 'nothing was written');
  } finally {
    await s.cleanup();
  }
});

test('step-output-budget: a non-text (default-json) result is measured and spilled as its JSON text', async () => {
  const s = await tempStore();
  try {
    const original = defaultTool();
    const { tools } = withStepOutputBudget(
      { read: original },
      { store: s.store, budgetChars: 100 },
    );
    // Decoration preserves execute (and thus the typed output) bit-for-bit — same contract as withReminders.
    assert.equal(tools.read.execute, original.execute);

    await render(tools.read, { pad: 'a'.repeat(200) }); // json render > budget → next result spills
    const spilledOut = { body: 'b'.repeat(50) };
    const spilled = await render(tools.read, spilledOut);
    const m = String(spilled.value).match(NOTICE);
    assert.ok(m, 'json result over budget spills with a paging notice');
    assert.equal(await readFile(m[1] ?? '', 'utf8'), JSON.stringify(spilledOut));
  } finally {
    await s.cleanup();
  }
});

test('step-output-budget: an empty over-budget result is not spilled (nothing to page)', async () => {
  const s = await tempStore();
  try {
    const { tools } = withStepOutputBudget(
      { echo: echoTool() },
      { store: s.store, budgetChars: 100 },
    );
    await render(tools.echo, 'a'.repeat(60));
    await render(tools.echo, 'b'.repeat(60));
    const empty = await render(tools.echo, '');
    assert.equal(empty.value, '', 'empty result shown as-is');
    assert.equal(await s.spillCount(), 0, 'no file written for an empty result');
  } finally {
    await s.cleanup();
  }
});

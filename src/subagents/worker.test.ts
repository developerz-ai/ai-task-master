import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { PrGroup } from '../state/schema.ts';
import {
  type BashInput,
  type BashOutput,
  createWorkerAgent,
  type FileManifest,
  type ReadFileInput,
  type ReadFileOutput,
  runWorker,
  WORKER_SYSTEM_PREFIX,
  type WorkerInput,
  type WorkerTools,
  type WriteFileInput,
  type WriteFileOutput,
} from './worker.ts';

function emptyUsage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
    totalTokens: 2,
  };
}

function makeWorkerModel(manifest: FileManifest, summaries: string[] = []): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const idx = i++;
      const text = idx === 0 ? JSON.stringify(manifest) : (summaries[idx - 1] ?? `edited #${idx}`);
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
}

type ToolCallLog = {
  reads: ReadFileInput[];
  writes: WriteFileInput[];
  bashes: BashInput[];
};

function makeTools(opts: { bashExitCode?: number; bashStderr?: string } = {}): {
  tools: WorkerTools;
  calls: ToolCallLog;
} {
  const calls: ToolCallLog = { reads: [], writes: [], bashes: [] };
  const tools: WorkerTools = {
    readFile: tool<ReadFileInput, ReadFileOutput>({
      description: 'read a file from the worktree',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => {
        calls.reads.push(input);
        return { content: '' };
      },
    }),
    writeFile: tool<WriteFileInput, WriteFileOutput>({
      description: 'write a file in the worktree',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async (input) => {
        calls.writes.push(input);
        return { ok: true };
      },
    }),
    bash: tool<BashInput, BashOutput>({
      description: 'run a bash command in the worktree',
      inputSchema: z.object({ command: z.string() }),
      execute: async (input) => {
        calls.bashes.push(input);
        return {
          stdout: '',
          stderr: opts.bashStderr ?? '',
          exitCode: opts.bashExitCode ?? 0,
        };
      },
    }),
  };
  return { tools, calls };
}

function baseGroup(overrides: Partial<PrGroup> = {}): PrGroup {
  return {
    id: 'core',
    title: 'Core features',
    tasks: ['task A', 'task B'],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    ...overrides,
  };
}

function baseInput(group: PrGroup = baseGroup()): WorkerInput {
  return {
    group,
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    styleContents: '# style\n',
    rollingContext: '',
  };
}

test('WORKER_SYSTEM_PREFIX mentions FileManifest + the two phases', () => {
  assert.match(WORKER_SYSTEM_PREFIX, /FileManifest/);
  assert.match(WORKER_SYSTEM_PREFIX, /Phase 1/);
  assert.match(WORKER_SYSTEM_PREFIX, /Phase 2/);
});

test('createWorkerAgent builds an agent that exposes the injected tools', () => {
  const { tools } = makeTools();
  const agent = createWorkerAgent({
    model: new MockLanguageModelV3(),
    tools,
    systemPrompt: 'style',
  });
  assert.ok(agent);
  assert.strictEqual(agent.tools, tools);
});

test('runWorker: manifest → per-file edits → commit sequence', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'src/b.ts', kind: 'modify', purpose: 'fix b' },
    ],
    draftCommitMessage: 'feat: add a + fix b',
  };
  const { tools, calls } = makeTools();
  const model = makeWorkerModel(manifest, ['created a', 'fixed b']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  if (result.kind !== 'ok') {
    throw new Error(`expected ok, got ${result.kind}: ${JSON.stringify(result)}`);
  }
  const d = result.delivery;
  assert.equal(d.branch, 'aitm/core');
  assert.equal(d.draftCommitMessage, 'feat: add a + fix b');
  assert.deepEqual(d.changes, [
    { path: 'src/a.ts', kind: 'create', summary: 'created a' },
    { path: 'src/b.ts', kind: 'modify', summary: 'fixed b' },
  ]);
  assert.deepEqual(d.progressEntries, ['- task A', '- task B']);

  // Final bash sequence: checkout -B, add -A, commit -m
  assert.equal(calls.bashes.length, 3);
  const cmds = calls.bashes.map((b) => b.command);
  assert.match(cmds[0] ?? '', /git -C '\/tmp\/wt' checkout -B 'aitm\/core'/);
  assert.match(cmds[1] ?? '', /git -C '\/tmp\/wt' add -A/);
  assert.match(cmds[2] ?? '', /git -C '\/tmp\/wt' commit -m 'feat: add a \+ fix b'/);
});

test('runWorker collapses multi-line editor responses to a one-line summary', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/x.ts', kind: 'create', purpose: 'create x' }],
    draftCommitMessage: 'feat: x',
  };
  const { tools } = makeTools();
  // Editor returns multi-line text; Worker must keep only the first line.
  const model = makeWorkerModel(manifest, ['  added new module x\nplus extra noise']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.equal(result.delivery.changes[0]?.summary, 'added new module x');
  }
});

test('runWorker uses the group.branch when set, instead of the aitm/<id> default', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/x.ts', kind: 'create', purpose: 'create x' }],
    draftCommitMessage: 'feat: x',
  };
  const { tools, calls } = makeTools();
  const model = makeWorkerModel(manifest, ['ok']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput(baseGroup({ branch: 'feature/custom' })));
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.equal(result.delivery.branch, 'feature/custom');
  }
  assert.match(calls.bashes[0]?.command ?? '', /checkout -B 'feature\/custom'/);
});

test('runWorker returns blocked when the manifest is empty', async () => {
  const manifest: FileManifest = { files: [], draftCommitMessage: 'chore: noop' };
  const { tools, calls } = makeTools();
  const model = makeWorkerModel(manifest);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'blocked');
  // No commit should be attempted on a blocked run.
  assert.equal(calls.bashes.length, 0);
});

test('runWorker returns error when the manifest output is not valid JSON', async () => {
  const { tools } = makeTools();
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'not json at all' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'error');
});

test('runWorker returns error when bash fails during commit', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/x.ts', kind: 'create', purpose: 'create x' }],
    draftCommitMessage: 'feat: x',
  };
  const { tools } = makeTools({ bashExitCode: 1, bashStderr: 'fatal: nothing to commit' });
  const model = makeWorkerModel(manifest, ['done']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /bash failed \(1\)/);
    assert.match(result.error, /fatal: nothing to commit/);
  }
});

test('runWorker rejects an agent not built by createWorkerAgent', async () => {
  const result = await runWorker({} as never, baseInput());
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') {
    assert.match(result.error, /not built by createWorkerAgent/);
  }
});

test('runWorker fans out editors in parallel — manifest call comes first, edits afterwards', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'a' },
      { path: 'src/b.ts', kind: 'create', purpose: 'b' },
      { path: 'src/c.ts', kind: 'create', purpose: 'c' },
    ],
    draftCommitMessage: 'feat: abc',
  };
  const { tools } = makeTools();
  // Hold the editor responses behind an externally-controlled barrier so we can
  // observe that all three editors are in-flight before any of them resolves.
  let resolveBarrier!: () => void;
  const barrier = new Promise<void>((r) => {
    resolveBarrier = r;
  });
  let editorStarted = 0;
  let editorFinished = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      if (editorStarted === 0 && editorFinished === 0) {
        editorStarted++;
        return {
          content: [{ type: 'text', text: JSON.stringify(manifest) }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      editorStarted++;
      const inFlight = editorStarted - 1 - editorFinished;
      // The first editor enters with inFlight=1. By the time the third editor
      // starts (still before the barrier), we expect inFlight=3 — proves parallelism.
      const observed = inFlight;
      await barrier;
      editorFinished++;
      return {
        content: [{ type: 'text', text: `edited (inFlight=${observed})` }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const run = runWorker(agent, baseInput());
  // Let the manifest call settle and editors fan out before releasing the barrier.
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  resolveBarrier();
  const result = await run;
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    const summaries = result.delivery.changes.map((c) => c.summary);
    // At least one editor must have observed in-flight > 1.
    const maxInFlight = Math.max(
      ...summaries.map((s) => Number(/inFlight=(\d+)/.exec(s)?.[1] ?? '0')),
    );
    assert.ok(maxInFlight >= 2, `expected parallel fanout, got ${summaries.join(' / ')}`);
  }
});

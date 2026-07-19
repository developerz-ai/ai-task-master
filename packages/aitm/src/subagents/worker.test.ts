import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { PrGroup, Task } from '../state/schema.ts';
import {
  type BashInput,
  type BashOutput,
  createWorkerAgent,
  editorToolSet,
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
      // Call 0 is the manifest agent — delivered via the submit tool-call. Later calls are the
      // per-file editors, which return a plain text summary (they don't use structured output).
      if (idx === 0) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: `submit-${idx}`,
              toolName: 'submit',
              input: JSON.stringify(manifest),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: summaries[idx - 1] ?? `edited #${idx}` }],
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
  // runEditor's per-file `git status --porcelain` verification, kept out of `bashes` so the
  // commit-phase bash assertions stay about the checkout/add/commit sequence only.
  statuses: BashInput[];
};

// `cleanStatusPaths` lists the paths that `git status --porcelain` reports as unchanged — i.e. the
// editor narrated but never wrote (a phantom edit). Every other queried path reports dirty, so the
// default (no phantom) keeps the existing happy-path tests recording changes.
function makeTools(
  opts: { bashExitCode?: number; bashStderr?: string; cleanStatusPaths?: string[] } = {},
): {
  tools: WorkerTools;
  calls: ToolCallLog;
} {
  const calls: ToolCallLog = { reads: [], writes: [], bashes: [], statuses: [] };
  const tools: WorkerTools = {
    readFile: tool<ReadFileInput, ReadFileOutput>({
      description: 'read a file from the checkout',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => {
        calls.reads.push(input);
        return { content: '' };
      },
    }),
    writeFile: tool<WriteFileInput, WriteFileOutput>({
      description: 'write a file in the checkout',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async (input) => {
        calls.writes.push(input);
        return { ok: true };
      },
    }),
    bash: tool<BashInput, BashOutput>({
      description: 'run a bash command in the checkout',
      inputSchema: z.object({ command: z.string() }),
      execute: async (input) => {
        // The editor-change verification never mutates and is exit-0 regardless of bashExitCode.
        if (input.command.includes('status --porcelain')) {
          calls.statuses.push(input);
          const path = /-- '(.*)'\s*$/.exec(input.command)?.[1] ?? '';
          const clean = (opts.cleanStatusPaths ?? []).some((p) => p === path);
          return { stdout: clean ? '' : ` M ${path}\n`, stderr: '', exitCode: 0 };
        }
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
    tasks: [
      { id: 'task-a', text: 'task A', complexity: 'normal', done: false },
      { id: 'task-b', text: 'task B', complexity: 'normal', done: false },
    ],
    dependsOn: [],
    branch: null,
    pr: null,
    status: 'pending',
    stage: 'pending',
    ...overrides,
  };
}

function baseInput(group: PrGroup = baseGroup()): WorkerInput {
  return {
    group,
    checkoutPath: '/tmp/wt',
    baseBranch: 'main',
    styleContents: '# style\n',
    rollingContext: '',
  };
}

test('WORKER_SYSTEM_PREFIX is the Coordinator: file manifest + the split/right-size judgment', () => {
  assert.match(WORKER_SYSTEM_PREFIX, /Coordinator/);
  assert.match(WORKER_SYSTEM_PREFIX, /file manifest/);
  assert.match(WORKER_SYSTEM_PREFIX, /Split heuristic/);
  assert.match(WORKER_SYSTEM_PREFIX, /Right-size/);
  // The "only the coordinator spawns" boundary and leaf independence, the product principles §2a adds.
  assert.match(WORKER_SYSTEM_PREFIX, /Only you spawn; leaves never spawn\./);
  assert.match(WORKER_SYSTEM_PREFIX, /every entry MUST be independent/);
});

test('WORKER_SYSTEM_PREFIX carries the explore delegation guidance, gated on availability (issue #126)', () => {
  assert.match(WORKER_SYSTEM_PREFIX, /`explore` when present/);
  assert.match(WORKER_SYSTEM_PREFIX, /in parallel/);
});

test('editorToolSet strips the runtime explore + memory + background extras so editors never nest surveys, touch memory, or manage background processes (issues #126/#118/#103)', () => {
  const stub = (desc: string) =>
    tool({ description: desc, inputSchema: z.object({ x: z.string() }), execute: async () => 'a' });
  // Reuse the complete WorkerTools fixture and add the runtime-only extras, exactly as the adapter
  // mounts them — no `as unknown as` bypass of the contract.
  const withExtras = {
    ...makeTools().tools,
    explore: stub('e'),
    memory: stub('m'),
    bashOutput: stub('o'),
    killBash: stub('k'),
  };
  const stripped = editorToolSet(withExtras);
  assert.equal('explore' in stripped, false, 'explore removed');
  assert.equal('memory' in stripped, false, 'memory removed');
  assert.equal('bashOutput' in stripped, false, 'bashOutput removed');
  assert.equal('killBash' in stripped, false, 'killBash removed');
  assert.equal('readFile' in stripped, true, 'other tools retained');
});

test('editorToolSet returns a set without explore unchanged (no-op when the extra is absent)', () => {
  const tools = makeTools().tools;
  const result = editorToolSet(tools);
  assert.equal('explore' in result, false, 'no explore to strip');
  assert.deepEqual(
    Object.keys(result).sort(),
    Object.keys(tools).sort(),
    'every original tool retained',
  );
});

test('runWorker: prepends the contextBlock to the manifest (first user) message, ahead of the task text (issue #106)', async () => {
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      // Call 0 is the manifest agent; capture its first user message.
      if (sent === '') sent = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-0',
            toolName: 'submit',
            input: JSON.stringify({ files: [], draftCommitMessage: 'noop' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  await runWorker(agent, {
    ...baseInput(),
    contextBlock: '<system-reminder>\nWORKER-CTX\n</system-reminder>',
  });
  assert.match(sent, /WORKER-CTX/, 'the context block reached the manifest message');
  // "PR group:" (with the colon) is unique to the manifest user message; the bare phrase also
  // appears in the system prompt.
  assert.ok(
    sent.indexOf('WORKER-CTX') < sent.indexOf('PR group:'),
    'the context block leads, ahead of the task text',
  );
});

test('runWorker: an ok result carries a handle retaining the manifest conversation (issue #107)', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  const { tools } = makeTools();
  const agent = createWorkerAgent({
    model: makeWorkerModel(manifest, ['created a']),
    tools,
    systemPrompt: WORKER_SYSTEM_PREFIX,
  });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    assert.ok(result.handle, 'the ok result exposes a handle');
    assert.ok(result.handle.messages.length > 0, 'the handle retains the manifest conversation');
  }
});

test('runWorker: a prior handle is continued — the retained conversation is replayed (issue #107)', async () => {
  // The prior handle owns the agent that gets continued; its retained messages must be replayed.
  let sent = '';
  const { tools } = makeTools();
  const priorAgent = createWorkerAgent({
    model: new MockLanguageModelV3({
      doGenerate: async (opts) => {
        sent = JSON.stringify(opts.prompt);
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 's',
              toolName: 'submit',
              input: JSON.stringify({ files: [], draftCommitMessage: 'noop' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      },
    }),
    tools,
    systemPrompt: WORKER_SYSTEM_PREFIX,
  });
  const priorHandle = {
    agent: priorAgent,
    messages: [{ role: 'user' as const, content: 'PRIOR-MANIFEST-CONVERSATION' }],
  };
  // The `agent` arg is unused when a prior handle is set — continuation runs on priorHandle.agent.
  const throwaway = createWorkerAgent({
    model: new MockLanguageModelV3(),
    tools,
    systemPrompt: WORKER_SYSTEM_PREFIX,
  });
  await runWorker(throwaway, { ...baseInput(), priorHandle });
  assert.match(sent, /PRIOR-MANIFEST-CONVERSATION/, 'the prior conversation was replayed');
});

test('WORKER_SYSTEM_PREFIX carries the compaction continuation contract (issue #102)', () => {
  assert.match(WORKER_SYSTEM_PREFIX, /summarized/i);
  assert.match(WORKER_SYSTEM_PREFIX, /resume from the summary/i);
  assert.match(WORKER_SYSTEM_PREFIX, /do not re-plan from\s+scratch or hand off early/i);
});

test('createWorkerAgent builds an agent that exposes the injected tools', () => {
  const { tools } = makeTools();
  const agent = createWorkerAgent({
    model: new MockLanguageModelV3(),
    tools,
    systemPrompt: 'style',
  });
  assert.ok(agent);
  // The factory registers the injected tools plus the terminal submit tool.
  assert.deepEqual(Object.keys(agent.tools).sort(), ['bash', 'readFile', 'submit', 'writeFile']);
  assert.strictEqual(agent.tools.readFile, tools.readFile);
});

test('createWorkerAgent forwards timeout → a stalled manifest step surfaces as a deadline error (issue #129)', async () => {
  const { tools } = makeTools();
  const stalling = new MockLanguageModelV3({
    doGenerate: (opts) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      }),
  });
  const agent = createWorkerAgent({
    model: stalling,
    tools,
    systemPrompt: WORKER_SYSTEM_PREFIX,
    timeout: { stepMs: 40 },
  });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.error, /exceeded the configured deadline/);
});

test('runWorker: one editor rejecting aborts its siblings (editor-fanout shared abort)', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'src/b.ts', kind: 'modify', purpose: 'fix b' },
    ],
    draftCommitMessage: 'feat: add a + fix b',
  };
  const { tools } = makeTools();
  let siblingAborted = false;
  let i = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const idx = i++;
      if (idx === 0) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'submit-0',
              toolName: 'submit',
              input: JSON.stringify(manifest),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      // First editor call (src/a.ts) rejects outright; the second (src/b.ts) never resolves on its
      // own — it only settles once it observes the shared controller's abort, proving the reject
      // above propagated to its sibling instead of letting it run to completion (issue: editor
      // fanout shared abort).
      if (idx === 1) {
        throw new Error('editor for src/a.ts failed');
      }
      return new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener('abort', () => {
          siblingAborted = true;
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    },
  });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'error');
  assert.ok(siblingAborted, 'the sibling editor observed the shared abort signal');
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

  // Each recorded change was confirmed on disk first: one `git status --porcelain` per planned file.
  assert.equal(calls.statuses.length, 2);
  assert.ok(calls.statuses.every((s) => s.command.includes('status --porcelain')));

  // Final bash sequence: checkout -B, add -A, reset .ai-task-master, commit -m
  assert.equal(calls.bashes.length, 4);
  const cmds = calls.bashes.map((b) => b.command);
  assert.match(cmds[0] ?? '', /git -C '\/tmp\/wt' checkout -B 'aitm\/core'/);
  assert.match(cmds[1] ?? '', /git -C '\/tmp\/wt' add -A/);
  // Never stage aitm's own state dir into the target-repo commit (issue #89): unstage it after add,
  // which also stays clear of the "paths are ignored" error when .ai-task-master is gitignored.
  assert.match(cmds[2] ?? '', /reset -q -- \.ai-task-master/);
  assert.match(cmds[3] ?? '', /git -C '\/tmp\/wt' commit -m 'feat: add a \+ fix b'/);
});

test('runWorker: creates the group branch before the editor fanout writes (branch-before-edit, audit 02)', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'src/b.ts', kind: 'modify', purpose: 'fix b' },
    ],
    draftCommitMessage: 'feat: a + b',
  };
  // One unified timeline so the checkout can be ordered against the fanout: each editor's on-disk
  // verification (`git status --porcelain -- <path>`) marks that file's edit as complete.
  const order: string[] = [];
  const bash = tool<BashInput, BashOutput>({
    description: 'run a bash command in the checkout',
    inputSchema: z.object({ command: z.string() }),
    execute: async (input) => {
      if (input.command.includes('status --porcelain')) {
        const path = /-- '(.*)'\s*$/.exec(input.command)?.[1] ?? '';
        order.push(`edit:${path}`);
        return { stdout: ` M ${path}\n`, stderr: '', exitCode: 0 };
      }
      if (input.command.includes('checkout -B')) order.push('checkout');
      else if (input.command.includes('add -A')) order.push('add');
      else if (input.command.includes('commit -m')) order.push('commit');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const tools: WorkerTools = { ...makeTools().tools, bash };
  const model = makeWorkerModel(manifest, ['created a', 'fixed b']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');

  // Ordering: branch checkout → the editor fanout (both files) → stage → commit.
  const checkoutIdx = order.indexOf('checkout');
  const firstEditIdx = order.findIndex((e) => e.startsWith('edit:'));
  const addIdx = order.indexOf('add');
  assert.ok(checkoutIdx >= 0, 'the group branch is checked out');
  assert.ok(
    checkoutIdx < firstEditIdx,
    `branch checkout must precede the editor fanout, got ${order.join(',')}`,
  );
  assert.ok(firstEditIdx < addIdx, 'edits precede staging');
});

test('runWorker: a narrate-only editor (no on-disk write) records no change and blocks — no phantom edit', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  // The editor returns a summary but never wrote src/a.ts, so `git status --porcelain` reports it clean.
  const { tools, calls } = makeTools({ cleanStatusPaths: ['src/a.ts'] });
  const model = makeWorkerModel(manifest, ['pretended to edit a']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /no on-disk change/i);
    assert.match(result.reason, /src\/a\.ts/);
    assert.match(result.reason, /more capable/i);
  }
  // The path was verified on disk. The group branch is created before the editor fanout
  // (branch-before-edit), but the phantom is caught before staging — nothing is added or committed.
  assert.ok(calls.statuses.some((s) => s.command.includes("status --porcelain -- 'src/a.ts'")));
  const cmds = calls.bashes.map((b) => b.command);
  assert.equal(
    cmds.some((c) => /add -A|commit -m/.test(c)),
    false,
    'no add/commit on a phantom edit',
  );
});

test('runWorker: one phantom editor blocks the whole pass and names only the unchanged file — no partial commit', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'src/b.ts', kind: 'modify', purpose: 'fix b' },
    ],
    draftCommitMessage: 'feat: a + b',
  };
  // Editor a writes (dirty); editor b only narrates (clean) — a phantom edit for b.
  const { tools, calls } = makeTools({ cleanStatusPaths: ['src/b.ts'] });
  const model = makeWorkerModel(manifest, ['created a', 'talked about b']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /src\/b\.ts/);
    assert.equal(result.reason.includes('src/a.ts'), false, 'only the unchanged path is named');
  }
  // A real edit to a MUST NOT be committed on its own when a sibling file was never written. The
  // group branch is created before the fanout (branch-before-edit), but the phantom blocks staging.
  const cmds = calls.bashes.map((b) => b.command);
  assert.equal(
    cmds.some((c) => /add -A|commit -m/.test(c)),
    false,
    'no partial commit when any planned file is unchanged',
  );
  assert.equal(calls.statuses.length, 2, 'both planned files were verified on disk');
});

test('runWorker: scopes the manifest prompt and progress to the current Task slice', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  const { tools } = makeTools();
  let manifestPrompt = '';
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const idx = call++;
      if (idx === 0) {
        manifestPrompt = JSON.stringify(options.prompt);
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'submit-0',
              toolName: 'submit',
              input: JSON.stringify(manifest),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: 'created a' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  // baseGroup carries task A + task B; focus the pass on a single task slice.
  const task: Task = { id: 'task-b', text: 'task B only', complexity: 'complex', done: false };
  const result = await runWorker(agent, { ...baseInput(), task });
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    // Progress reflects only the focused task, not every task in the group.
    assert.deepEqual(result.delivery.progressEntries, ['- task B only']);
  }
  // The manifest prompt centers on the current task (text + complexity) and drops the sibling.
  assert.match(manifestPrompt, /task B only/);
  assert.match(manifestPrompt, /complex/);
  assert.equal(manifestPrompt.includes('task A'), false, 'sibling task omitted in task mode');
});

test('runWorker runs formatCommand in the checkout before staging when set (issue #48)', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  const { tools, calls } = makeTools();
  const model = makeWorkerModel(manifest, ['created a']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, { ...baseInput(), formatCommand: 'bun run lint:fix' });
  assert.equal(result.kind, 'ok');

  // Sequence: checkout -B, <format>, add -A, reset .ai-task-master, commit. Format runs before add.
  const cmds = calls.bashes.map((b) => b.command);
  assert.equal(cmds.length, 5);
  assert.match(cmds[0] ?? '', /checkout -B/);
  assert.match(cmds[1] ?? '', /cd '\/tmp\/wt' && bun run lint:fix/);
  assert.match(cmds[2] ?? '', /add -A/);
  assert.match(cmds[3] ?? '', /reset -q -- \.ai-task-master/);
  assert.match(cmds[4] ?? '', /commit -m/);
});

test('runWorker omits the format step when formatCommand is unset', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  const { tools, calls } = makeTools();
  const model = makeWorkerModel(manifest, ['created a']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  // No format step: exactly checkout, add, reset .ai-task-master, commit.
  assert.equal(calls.bashes.length, 4);
  assert.equal(
    calls.bashes.some((b) => b.command.includes('lint:fix')),
    false,
  );
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
  // The block reason must be actionable: name the empty manifest AND point at a more capable
  // model, so a user on a weak model gets guidance instead of a bare error (issue #45).
  if (result.kind === 'blocked') {
    assert.match(result.reason, /empty file manifest/i);
    assert.match(result.reason, /more capable/i);
  }
  // No commit should be attempted on a blocked run.
  assert.equal(calls.bashes.length, 0);
});

test('runWorker: persistently schema-invalid manifest → error after retries, naming schema validation (issue #101)', async () => {
  const { tools } = makeTools();
  // submit called with args that don't match FileManifestSchema (files is not an array) on every
  // attempt → the schema-retry kernel exhausts → error, distinct from the empty-manifest blocked.
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'submit-0',
          toolName: 'submit',
          input: JSON.stringify({ files: 'nope', draftCommitMessage: 'x' }),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: emptyUsage(),
      warnings: [],
    }),
  });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.error, /schema validation after retries/i);
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
          content: [
            {
              type: 'tool-call',
              toolCallId: 'submit-0',
              toolName: 'submit',
              input: JSON.stringify(manifest),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
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

// ---- verifyCommand gate (issue #122) ----

const VERIFY_TIMEOUT_MS = 600_000;

// Bash fake that discriminates the verify invocation by its 600s timeout — only the verify call
// carries `timeoutMs`. verifyExitCodes[] drives successive verify outcomes; every other command
// (checkout / format / add / commit) exits 0. Records all bash inputs and the verify subset.
function makeVerifyTools(verifyExitCodes: number[]): {
  tools: WorkerTools;
  bashes: BashInput[];
  verifies: BashInput[];
} {
  const bashes: BashInput[] = [];
  const verifies: BashInput[] = [];
  let vi = 0;
  const base = makeTools().tools;
  const bash = tool<BashInput, BashOutput>({
    description: 'run a bash command in the checkout',
    inputSchema: z.object({
      command: z.string(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    execute: async (input) => {
      // Editors in the verify path are simulated as having written their file, so the per-file
      // `git status --porcelain` check reports dirty (and stays out of the `bashes` sequence).
      if (input.command.includes('status --porcelain')) {
        const path = /-- '(.*)'\s*$/.exec(input.command)?.[1] ?? '';
        return { stdout: ` M ${path}\n`, stderr: '', exitCode: 0 };
      }
      bashes.push(input);
      if (input.timeoutMs === VERIFY_TIMEOUT_MS) {
        const i = vi++;
        verifies.push(input);
        const code = verifyExitCodes[i] ?? 0;
        return {
          stdout: `verify stdout ${i}`,
          stderr: code === 0 ? '' : `VERIFY FAILED marker-${i}`,
          exitCode: code,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  return { tools: { ...base, bash }, bashes, verifies };
}

// Model that submits a manifest at specific call indices (main pass at 0, fix pass later) and
// returns editor text otherwise. Records the prompt seen at each call + counts submits.
function makeManifestModel(submits: Array<{ at: number; manifest: FileManifest }>): {
  model: MockLanguageModelV3;
  prompts: string[];
  submitCount: () => number;
} {
  const prompts: string[] = [];
  let i = 0;
  let submitted = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const idx = i++;
      prompts[idx] = JSON.stringify(options.prompt);
      const hit = submits.find((s) => s.at === idx);
      if (hit) {
        submitted++;
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: `submit-${idx}`,
              toolName: 'submit',
              input: JSON.stringify(hit.manifest),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text', text: `edited #${idx}` }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  return { model, prompts, submitCount: () => submitted };
}

function makeCaptureLogger(events: Array<Record<string, unknown>>) {
  const rec =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      events.push({ level, msg, ...(fields ?? {}) });
    };
  return {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    status: () => {},
    flush: async () => {},
  };
}

const oneFileManifest: FileManifest = {
  files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
  draftCommitMessage: 'feat: a',
};
const fixManifest: FileManifest = {
  files: [{ path: 'src/a.ts', kind: 'modify', purpose: 'fix the failing test' }],
  draftCommitMessage: 'fix: make verify pass',
};

test('runWorker verifyCommand green: one verify (timeoutMs 600000) before git add, then normal commit', async () => {
  const { model } = makeManifestModel([{ at: 0, manifest: oneFileManifest }]);
  const { tools, bashes, verifies } = makeVerifyTools([0]); // verify passes first try
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, { ...baseInput(), verifyCommand: 'run-verify' });
  assert.equal(result.kind, 'ok');

  assert.equal(verifies.length, 1);
  assert.equal(verifies[0]?.timeoutMs, VERIFY_TIMEOUT_MS);
  // Bash order: checkout -B, verify, add -A, commit — the git commands are identical to today's,
  // with exactly one verify invocation inserted before `git add`.
  const cmds = bashes.map((b) => b.command);
  assert.equal(cmds.length, 5);
  assert.match(cmds[0] ?? '', /git -C '\/tmp\/wt' checkout -B 'aitm\/core'/);
  assert.match(cmds[1] ?? '', /cd '\/tmp\/wt' && run-verify/);
  assert.match(cmds[2] ?? '', /add -A/);
  assert.match(cmds[3] ?? '', /reset -q -- \.ai-task-master/);
  assert.match(cmds[4] ?? '', /commit -m 'feat: a'/);
  const verifyIdx = cmds.findIndex((c) => c.includes('run-verify'));
  const addIdx = cmds.findIndex((c) => c.includes('add -A'));
  assert.ok(verifyIdx >= 0 && verifyIdx < addIdx, 'verify must run before git add');
});

test('runWorker verifyCommand red→green: exactly one fix pass, two verifies, then commits', async () => {
  const { model, prompts, submitCount } = makeManifestModel([
    { at: 0, manifest: oneFileManifest },
    { at: 2, manifest: fixManifest }, // fix-pass manifest after the 1 editor at call 1
  ]);
  const { tools, bashes, verifies } = makeVerifyTools([1, 0]); // red, then green
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, { ...baseInput(), verifyCommand: 'run-verify' });
  assert.equal(result.kind, 'ok');

  assert.equal(verifies.length, 2);
  assert.equal(submitCount(), 2, 'exactly one fix-pass manifest run (main + one fix)');
  assert.ok(
    bashes.some((b) => b.command.includes('commit -m')),
    'the change is committed after the green re-verify',
  );
  // delivery.changes reflects the first-pass edit AND the fix-pass edit (all committed files).
  if (result.kind === 'ok') {
    assert.deepEqual(
      result.delivery.changes.map((c) => `${c.kind} ${c.path}`),
      ['create src/a.ts', 'modify src/a.ts'],
    );
  }
  // The fix-task manifest prompt (model call 2) carries the failing verify output tail.
  assert.match(prompts[2] ?? '', /verify command failed/i);
  assert.match(prompts[2] ?? '', /VERIFY FAILED marker-0/);
});

test('runWorker verifyCommand red twice: blocked with the verify tail, nothing staged or committed', async () => {
  const { model } = makeManifestModel([
    { at: 0, manifest: oneFileManifest },
    { at: 2, manifest: fixManifest },
  ]);
  const { tools, bashes, verifies } = makeVerifyTools([1, 1]); // red, red
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, { ...baseInput(), verifyCommand: 'run-verify' });
  assert.equal(result.kind, 'blocked');
  if (result.kind === 'blocked') {
    assert.match(result.reason, /still failed/i);
    assert.match(result.reason, /VERIFY FAILED marker-1/);
  }
  assert.equal(verifies.length, 2);
  const cmds = bashes.map((b) => b.command);
  assert.equal(
    cmds.some((c) => c.includes('add -A')),
    false,
    'no git add on a doubly-red verify',
  );
  assert.equal(
    cmds.some((c) => c.includes('commit -m')),
    false,
    'no git commit on a doubly-red verify',
  );
});

test('runWorker without verifyCommand: zero verify invocations, byte-identical git sequence (regression guard)', async () => {
  const { model } = makeManifestModel([{ at: 0, manifest: oneFileManifest }]);
  const { tools, bashes, verifies } = makeVerifyTools([1]); // would fail IF ever called
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput()); // verifyCommand unset
  assert.equal(result.kind, 'ok');
  assert.equal(verifies.length, 0);
  assert.equal(
    bashes.some((b) => b.timeoutMs === VERIFY_TIMEOUT_MS),
    false,
  );
  // Exactly checkout, add, reset .ai-task-master, commit — no extra bash calls.
  assert.equal(bashes.length, 4);
  assert.match(bashes[0]?.command ?? '', /checkout -B/);
  assert.match(bashes[1]?.command ?? '', /add -A/);
  assert.match(bashes[2]?.command ?? '', /reset -q -- \.ai-task-master/);
  assert.match(bashes[3]?.command ?? '', /commit -m/);
});

test('runWorker: an oversized rollingContext is truncated in the manifest prompt (slice-cap discipline)', async () => {
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      if (sent === '') sent = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-0',
            toolName: 'submit',
            input: JSON.stringify({ files: [], draftCommitMessage: 'noop' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const oversized = 'x'.repeat(10_000);
  await runWorker(agent, { ...baseInput(), rollingContext: oversized });
  assert.ok(!sent.includes(oversized), 'the raw oversized rollingContext never reaches the prompt');
  assert.match(sent, /truncated/, 'a truncation marker is present');
});

test('runWorker: an oversized group.title / task.text is capped in the manifest prompt', async () => {
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      if (sent === '') sent = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-0',
            toolName: 'submit',
            input: JSON.stringify({ files: [], draftCommitMessage: 'noop' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const oversizedTitle = 'T'.repeat(2_000);
  const task: Task = { id: 'huge', text: 'A'.repeat(2_000), complexity: 'normal', done: false };
  await runWorker(agent, {
    ...baseInput(baseGroup({ title: oversizedTitle })),
    task,
  });
  assert.ok(!sent.includes(oversizedTitle), 'the raw oversized title never reaches the prompt');
  assert.ok(!sent.includes(task.text), 'the raw oversized task text never reaches the prompt');
  assert.match(sent, /truncated/, 'a truncation marker is present');
});

test('runEditor system prompt: drops the harness/communication/autonomy contract stack, keeps role guidance + style + env (lean leaf)', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  let editorSystem = '';
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const idx = call++;
      if (idx === 0) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'submit-0',
              toolName: 'submit',
              input: JSON.stringify(manifest),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      editorSystem = JSON.stringify(opts.prompt);
      return {
        content: [{ type: 'text', text: 'created a' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, { ...baseInput(), styleContents: '# style essentials' });
  assert.equal(result.kind, 'ok');
  assert.doesNotMatch(editorSystem, /Harness contract:/);
  assert.doesNotMatch(editorSystem, /Communication contract:/);
  assert.doesNotMatch(editorSystem, /Autonomy:/);
  assert.match(editorSystem, /leaf editor/i, 'EDITOR_SYSTEM_PREFIX guidance retained');
  assert.match(editorSystem, /# style essentials/, 'style essentials retained');
  assert.match(editorSystem, /<env>/, 'env block retained');
});

test('runWorker verifyCommand emits one structured log event per verify invocation', async () => {
  const { model } = makeManifestModel([
    { at: 0, manifest: oneFileManifest },
    { at: 2, manifest: fixManifest },
  ]);
  const { tools } = makeVerifyTools([1, 0]); // red then green → two verify events
  const events: Array<Record<string, unknown>> = [];
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, {
    ...baseInput(),
    verifyCommand: 'run-verify',
    logger: makeCaptureLogger(events),
  });
  assert.equal(result.kind, 'ok');

  const verifyLogs = events.filter((e) => e.msg === 'worker: verify');
  assert.equal(verifyLogs.length, 2);
  assert.equal(verifyLogs[0]?.command, 'run-verify');
  assert.equal(verifyLogs[0]?.exitCode, 1);
  assert.equal(verifyLogs[0]?.fixPassFollowed, true);
  assert.equal(typeof verifyLogs[0]?.durationMs, 'number');
  assert.equal(verifyLogs[1]?.exitCode, 0);
  assert.equal(verifyLogs[1]?.fixPassFollowed, false);
});

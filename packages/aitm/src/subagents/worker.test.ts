import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { PrGroup, Task } from '../state/schema.ts';
import { render } from './prompts/templates.ts';
import {
  type BashInput,
  type BashOutput,
  belowFanoutFloor,
  buildPhantomRetryPrompt,
  buildTeamBrief,
  createWorkerAgent,
  editorToolSet,
  FANOUT_FLOOR_FILES,
  type FileManifest,
  type FileManifestEntry,
  groupManifestByDir,
  hasStrayEdit,
  labelEditorGroups,
  MANIFEST_SURVEY_BUDGET,
  MAX_FILES_PER_EDITOR,
  type ReadFileInput,
  type ReadFileOutput,
  readOnlyStreak,
  runWorker,
  surveyBudgetReminder,
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
// `strayEdits` makes the bare tree-wide `git status --porcelain` (no pathspec — the post-pass
// cleanup guard) report a dirty tree so a test can assert the reset/clean it triggers. Default
// false keeps the clean no-changes/blocked paths skipping cleanup, byte-identical to today.
// `phantomOncePaths` lists paths that report clean on their FIRST status query and dirty on every
// later one — a leaf that narrated the edit, then actually wrote it when the corrective retry told
// it what it had done.
// `preDirtyPaths` seeds the FIRST bare `git status --porcelain` (the self-review pre-planning
// snapshot) so those paths look inherited-dirty; the inline-edit inference must then still fan out.
// `preSnapshotFails` makes that first bare status exit non-zero, so dirtyPaths returns undefined and
// the inference is disabled. Both only affect the first bare call — the later post-pass cleanup guard
// stays clean (exit 0, empty) so neither triggers a reset.
function makeTools(
  opts: {
    bashExitCode?: number;
    bashStderr?: string;
    cleanStatusPaths?: string[];
    phantomOncePaths?: string[];
    strayEdits?: boolean;
    preDirtyPaths?: string[];
    preSnapshotFails?: boolean;
  } = {},
): {
  tools: WorkerTools;
  calls: ToolCallLog;
} {
  const calls: ToolCallLog = { reads: [], writes: [], bashes: [], statuses: [] };
  const statusQueries = new Map<string, number>();
  let bareStatusCount = 0;
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
        if (input.command.includes('status --porcelain')) {
          const path = /-- '(.*)'\s*$/.exec(input.command)?.[1] ?? '';
          // Bare tree-wide status (no pathspec) — the post-pass cleanup guard, not an editor's
          // per-file verification. Reports the tree dirty only when the test simulates stray edits;
          // never recorded in `bashes` so the clean no-op path stays byte-identical.
          if (path === '') {
            bareStatusCount += 1;
            // The FIRST bare status is the self-review pre-planning snapshot; drive it from the
            // pre-* opts. Every later bare call is the post-pass cleanup guard and stays clean.
            if (bareStatusCount === 1 && opts.preSnapshotFails) {
              return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 };
            }
            if (bareStatusCount === 1 && opts.preDirtyPaths && opts.preDirtyPaths.length > 0) {
              return {
                stdout: opts.preDirtyPaths.map((p) => ` M ${p}`).join('\n'),
                stderr: '',
                exitCode: 0,
              };
            }
            return {
              stdout: opts.strayEdits ? ' M stray.md\n?? stray-new.ts\n' : '',
              stderr: '',
              exitCode: 0,
            };
          }
          // The editor-change verification never mutates and is exit-0 regardless of bashExitCode.
          calls.statuses.push(input);
          const nth = (statusQueries.get(path) ?? 0) + 1;
          statusQueries.set(path, nth);
          const clean =
            (opts.cleanStatusPaths ?? []).some((p) => p === path) ||
            (nth === 1 && (opts.phantomOncePaths ?? []).some((p) => p === path));
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

test('WORKER_SYSTEM_PREFIX is the Coordinator: file manifest + the inline/fanout decision + right-sizing', () => {
  assert.match(WORKER_SYSTEM_PREFIX, /Coordinator/);
  assert.match(WORKER_SYSTEM_PREFIX, /file manifest/);
  assert.match(WORKER_SYSTEM_PREFIX, /INLINE/);
  assert.match(WORKER_SYSTEM_PREFIX, /FANOUT/);
  assert.match(WORKER_SYSTEM_PREFIX, /applied: true/);
  // The "only the coordinator spawns" boundary and leaf independence, the product principles §2a adds.
  assert.match(WORKER_SYSTEM_PREFIX, /Only you spawn; leaves never spawn\./);
  assert.match(WORKER_SYSTEM_PREFIX, /DISJOINT, non-interfering scopes/);
});

test('WORKER_SYSTEM_PREFIX carries the explore delegation guidance, gated on availability (issue #126)', () => {
  assert.match(WORKER_SYSTEM_PREFIX, /`explore` for broad or multi-file questions/);
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

test('runWorker: appends the progressBlock to the END of the manifest message, after the task text (slice 04 §4)', async () => {
  let sent = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      if (sent === '') sent = JSON.stringify(opts.prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'submit-prog',
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
    contextBlock: '<system-reminder>\nWORKER-LEAD\n</system-reminder>',
    progressBlock: '<system-reminder>\nWORKER-PROG-TAIL\n</system-reminder>',
  });
  assert.match(sent, /WORKER-PROG-TAIL/, 'the progress block reached the manifest message');
  // Lead first, task text ("PR group:") in the middle, progress last — the volatile bit trails the
  // cacheable prefix so it can never invalidate it per step.
  assert.ok(
    sent.indexOf('WORKER-LEAD') < sent.indexOf('PR group:'),
    'the leading context block precedes the task text',
  );
  assert.ok(
    sent.indexOf('PR group:') < sent.indexOf('WORKER-PROG-TAIL'),
    'the progress block trails the task text (out of the cacheable prefix)',
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

test("the Coordinator's rendered prompt carries the compaction continuation contract (issue #102)", () => {
  // The contract itself moved from this role's prose into the shared contextManagement block — it is
  // cross-cutting, and every role needs it. Assert on what the Coordinator actually receives, so the
  // invariant survives wherever the sentence lives.
  const rendered = render('role-prompt', {
    roleGuidance: WORKER_SYSTEM_PREFIX,
    maxSteps: 30,
    style: '',
    env: '<env>\n</env>',
  });
  assert.match(rendered, /summarized/i);
  assert.match(rendered, /resume from the summary/i);
  assert.match(rendered, /do not re-plan from scratch/i);
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
  // Distinct directories so the manifest fans out to two leaves (same-dir files collapse to one).
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'lib/b.ts', kind: 'modify', purpose: 'fix b' },
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
      // First editor call (src/a.ts) rejects outright; the second (lib/b.ts) never resolves on its
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
  // Distinct directories → two leaves, each fanned out in group order (src first, then lib).
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'lib/b.ts', kind: 'modify', purpose: 'fix b' },
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
    { path: 'lib/b.ts', kind: 'modify', summary: 'fixed b' },
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
  assert.equal(
    calls.statuses.length,
    3,
    'both planned files verified, then the phantom re-verified after its single retry',
  );
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

test('runWorker: empty manifest WITH noChangesNeeded → no-changes, no branch/commit', async () => {
  // Regression: a task that legitimately requires no code changes (verification-only, change
  // already in place) used to be conflated with the weak-model empty-manifest failure and blocked
  // its whole PR group. A reasoned empty manifest completes the task without a commit.
  const manifest: FileManifest = {
    files: [],
    draftCommitMessage: 'chore: noop',
    noChangesNeeded: 'the fix already landed; this task only verified it',
  };
  const { tools, calls } = makeTools();
  const model = makeWorkerModel(manifest);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'no-changes');
  if (result.kind === 'no-changes') {
    assert.match(result.reason, /already landed/);
  }
  // No branch checkout, no commit — nothing touched git.
  assert.equal(calls.bashes.length, 0);
});

test('runWorker: a no-changes pass with stray planning edits restores a clean tree (self-review clean left a dirty tree after merge)', async () => {
  // Regression: the manifest-planning agent holds the edit/write/bash tools and explores the diff
  // before submitting. A self-review "clean" pass (empty noChangesNeeded manifest) can tweak a file
  // during that survey, then declare nothing to fix — leaving the edit uncommitted. The shared
  // in-place checkout never auto-resets, so the stray edit surfaced after the PR merged as a
  // modified README.md. The non-commit exit paths now reset tracked files + drop untracked ones.
  const manifest: FileManifest = {
    files: [],
    draftCommitMessage: 'chore: noop',
    noChangesNeeded: 'already clean — nothing to fix',
  };
  const { tools, calls } = makeTools({ strayEdits: true });
  const model = makeWorkerModel(manifest);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'no-changes');

  // The cleanup guard detected a dirty tree and restored it: reset tracked files to HEAD, then drop
  // untracked ones. No add/commit (nothing was meant to ship from a no-changes declaration).
  const cmds = calls.bashes.map((b) => b.command);
  assert.ok(
    cmds.some((c) => /reset --hard HEAD/.test(c)),
    'a dirty tree is reset to HEAD',
  );
  assert.ok(
    cmds.some((c) => /clean -fd/.test(c)),
    'untracked stray files are cleaned',
  );
  assert.equal(
    cmds.some((c) => /add -A|commit -m/.test(c)),
    false,
    'a no-changes pass never stages or commits',
  );
});

test('runWorker: a blocked pass with stray edits restores a clean tree (no partial mutation leaks to the next branch)', async () => {
  const manifest: FileManifest = { files: [], draftCommitMessage: 'chore: noop' };
  const { tools, calls } = makeTools({ strayEdits: true });
  const model = makeWorkerModel(manifest);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'blocked');

  const cmds = calls.bashes.map((b) => b.command);
  assert.ok(
    cmds.some((c) => /reset --hard HEAD/.test(c)),
    'blocked dirty tree is reset',
  );
  assert.ok(
    cmds.some((c) => /clean -fd/.test(c)),
    'untracked stray files are cleaned',
  );
});

test('hasStrayEdit: state-dir entries never count as a dirty tree', () => {
  // In a repo that does not gitignore `.ai-task-master`, aitm's own untracked state files show up in
  // `git status --porcelain`. Counting them would hard-reset the checkout on every non-committing
  // pass — and `git clean` would delete the run's own plan and scratch.
  assert.equal(hasStrayEdit(''), false);
  assert.equal(hasStrayEdit('?? .ai-task-master/\n'), false);
  assert.equal(
    hasStrayEdit('?? .ai-task-master/state.json\n?? .ai-task-master/scratch/fuzz.ts\n'),
    false,
  );
  assert.equal(hasStrayEdit(' M README.md\n'), true);
  assert.equal(hasStrayEdit('?? .ai-task-master/state.json\n M README.md\n'), true);
});

test('runWorker: the stray-edit cleanup never deletes aitm own state dir', async () => {
  // `git clean -fd` without an exclude only spares .ai-task-master when the TARGET repo happens to
  // gitignore it; otherwise it wipes the run's plan, style cache, generated specialists, and scratch
  // mid-run. Same guard as InPlaceCheckout.ensureCleanTree.
  const manifest: FileManifest = { files: [], draftCommitMessage: 'chore: noop' };
  const { tools, calls } = makeTools({ strayEdits: true });
  const model = makeWorkerModel(manifest);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  await runWorker(agent, baseInput());

  const clean = calls.bashes.map((b) => b.command).find((c) => /clean -fd/.test(c));
  assert.ok(clean, 'the dirty tree was cleaned');
  assert.match(clean, /-e \.ai-task-master/, 'the state dir is excluded from the clean');
});

test('runWorker: a clean no-changes tree is left untouched (no-op cleanup, byte-identical git sequence)', async () => {
  const manifest: FileManifest = {
    files: [],
    draftCommitMessage: 'chore: noop',
    noChangesNeeded: 'already clean',
  };
  const { tools, calls } = makeTools(); // strayEdits unset → tree-wide status reports clean
  const model = makeWorkerModel(manifest);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'no-changes');
  const cmds = calls.bashes.map((b) => b.command);
  assert.equal(
    cmds.some((c) => /reset --hard|clean -fd/.test(c)),
    false,
    'a clean tree triggers no reset/clean',
  );
  assert.equal(calls.bashes.length, 0, 'no mutating git command runs on a clean no-changes pass');
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
  // Three distinct directories → three leaves, so the fanout has genuine parallelism to observe.
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'a' },
      { path: 'lib/b.ts', kind: 'create', purpose: 'b' },
      { path: 'api/c.ts', kind: 'create', purpose: 'c' },
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

// ---- inline-edit path: `applied: true` skips the editor fanout entirely ----

test('runWorker: manifest with `applied: true` skips the editor fanout and commits the Coordinator inline edits', async () => {
  // The Coordinator wrote everything itself — the fanout must not spawn any editor. The model is
  // called exactly once (the manifest submit); FileChanges come from the manifest purposes, not
  // editor summaries.
  let modelCalls = 0;
  const manifest: FileManifest = {
    files: [
      { path: 'src/errors/AppError.ts', kind: 'create', purpose: 'base AppError class' },
      { path: 'src/server/app.ts', kind: 'modify', purpose: 'wire errorHandler into app.onError' },
      { path: 'tests/errors.test.ts', kind: 'create', purpose: 'error mapper tests' },
    ],
    draftCommitMessage: 'feat: typed errors layer',
    applied: true,
  };
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      modelCalls++;
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
    },
  });
  const { tools, calls } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(
    modelCalls,
    1,
    'no editor fanout — the model is called exactly once (manifest submit)',
  );
  // The phantom-guard ran `git status` once per planned file.
  assert.equal(calls.statuses.length, manifest.files.length);
  assert.deepEqual(
    result.delivery.changes.map((c) => ({ path: c.path, summary: c.summary })),
    [
      { path: 'src/errors/AppError.ts', summary: 'base AppError class' },
      { path: 'src/server/app.ts', summary: 'wire errorHandler into app.onError' },
      { path: 'tests/errors.test.ts', summary: 'error mapper tests' },
    ],
  );
  assert.equal(result.delivery.draftCommitMessage, 'feat: typed errors layer');
  // The commit phase ran (the inline edits were committed, not fanned out).
  const cmds = calls.bashes.map((b) => b.command);
  assert.ok(
    cmds.some((c) => /commit/.test(c)),
    'the inline edits were committed',
  );
});

test('runWorker: `applied: true` with an unwritten file blocks (phantom guard) and commits nothing', async () => {
  // src/b.ts reports clean — the Coordinator claimed `applied` but never wrote it (a phantom).
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'src/b.ts', kind: 'create', purpose: 'create b' },
    ],
    draftCommitMessage: 'feat: a + b',
    applied: true,
  };
  const model = makeWorkerModel(manifest);
  const { tools, calls } = makeTools({ cleanStatusPaths: ['src/b.ts'] });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'blocked');
  if (result.kind !== 'blocked') return;
  assert.match(result.reason, /src\/b\.ts/);
  assert.match(result.reason, /applied/);
  // Nothing committed.
  const cmds = calls.bashes.map((b) => b.command);
  assert.ok(!cmds.some((c) => /commit/.test(c)), 'a phantom inline edit commits nothing');
});

// ---- editor team fanout: dir grouping + bounded pool + shared brief (slice 05) ----

test('groupManifestByDir: files in the same directory collapse onto one leaf', () => {
  const files: FileManifestEntry[] = [
    { path: 'src/a.ts', kind: 'create', purpose: 'a' },
    { path: 'src/b.ts', kind: 'modify', purpose: 'b' },
  ];
  const groups = groupManifestByDir(files, MAX_FILES_PER_EDITOR);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]?.map((f) => f.path),
    ['src/a.ts', 'src/b.ts'],
  );
});

test('groupManifestByDir: distinct directories fan out to separate leaves, order preserved', () => {
  const files: FileManifestEntry[] = [
    { path: 'src/a.ts', kind: 'create', purpose: 'a' },
    { path: 'lib/b.ts', kind: 'create', purpose: 'b' },
    { path: 'README.md', kind: 'modify', purpose: 'root file' },
  ];
  const groups = groupManifestByDir(files, MAX_FILES_PER_EDITOR);
  assert.deepEqual(
    groups.map((g) => g.map((f) => f.path)),
    [['src/a.ts'], ['lib/b.ts'], ['README.md']],
  );
});

test('groupManifestByDir: a directory over the cap is chunked, manifest order preserved', () => {
  const files: FileManifestEntry[] = ['1', '2', '3', '4', '5'].map((n) => ({
    path: `src/f${n}.ts`,
    kind: 'create',
    purpose: n,
  }));
  const groups = groupManifestByDir(files, 3);
  assert.deepEqual(
    groups.map((g) => g.map((f) => f.path)),
    [
      ['src/f1.ts', 'src/f2.ts', 'src/f3.ts'],
      ['src/f4.ts', 'src/f5.ts'],
    ],
  );
});

test('groupManifestByDir: a single-file manifest yields one single-file group (byte-identical path)', () => {
  const files: FileManifestEntry[] = [{ path: 'src/a.ts', kind: 'create', purpose: 'a' }];
  assert.deepEqual(groupManifestByDir(files, MAX_FILES_PER_EDITOR), [
    [{ path: 'src/a.ts', kind: 'create', purpose: 'a' }],
  ]);
});

test('labelEditorGroups: chunked same-directory leaves get distinct #n labels (issue #131)', () => {
  const files: FileManifestEntry[] = ['1', '2', '3', '4', '5'].map((n) => ({
    path: `src/f${n}.ts`,
    kind: 'create',
    purpose: n,
  }));
  const leaves = labelEditorGroups(groupManifestByDir(files, 3));
  assert.deepEqual(
    leaves.map((l) => l.label),
    ['src/ #1', 'src/ #2'],
    'two chunks of one oversized directory no longer collide on the bare `src/` label',
  );
});

test('labelEditorGroups: an unchunked directory and a lone file keep bare labels (byte-identical)', () => {
  const files: FileManifestEntry[] = [
    { path: 'src/auth/login.ts', kind: 'create', purpose: 'login' },
    { path: 'src/auth/logout.ts', kind: 'create', purpose: 'logout' },
    { path: 'README.md', kind: 'modify', purpose: 'docs' },
  ];
  const leaves = labelEditorGroups(groupManifestByDir(files, MAX_FILES_PER_EDITOR));
  assert.deepEqual(
    leaves.map((l) => ({ label: l.label, count: l.files.length })),
    [
      { label: 'src/auth/', count: 2 },
      { label: 'README.md', count: 1 },
    ],
    'a base label owned by a single leaf stays bare',
  );
});

test('labelEditorGroups: same-basename files in sibling directories get distinct labels (issue #131)', () => {
  const files: FileManifestEntry[] = [
    { path: 'a/f.ts', kind: 'create', purpose: 'a' },
    { path: 'b/f.ts', kind: 'create', purpose: 'b' },
  ];
  const leaves = labelEditorGroups(groupManifestByDir(files, MAX_FILES_PER_EDITOR));
  assert.deepEqual(
    leaves.map((l) => l.label),
    ['f.ts #1', 'f.ts #2'],
    'two single-file leaves sharing a basename no longer collide on the onEditorStepFinish tag',
  );
});

test('buildTeamBrief: carries the task, the full manifest, and the rolling context', () => {
  const files: FileManifestEntry[] = [
    { path: 'src/a.ts', kind: 'create', purpose: 'add module a' },
    { path: 'lib/b.ts', kind: 'modify', purpose: 'wire b to a' },
  ];
  const task: Task = { id: 't', text: 'ship feature X', complexity: 'complex', done: false };
  const brief = buildTeamBrief({ ...baseInput(), task, rollingContext: 'prior-PR-summary' }, files);
  assert.match(brief, /<team-brief>[\s\S]*<\/team-brief>/);
  assert.match(brief, /ship feature X/);
  assert.match(brief, /src\/a\.ts.*add module a/, 'each manifest file is listed with its purpose');
  assert.match(brief, /lib\/b\.ts.*wire b to a/);
  assert.match(brief, /prior-PR-summary/);
});

test('buildTeamBrief: caps an oversized rolling context', () => {
  const files: FileManifestEntry[] = [{ path: 'src/a.ts', kind: 'create', purpose: 'a' }];
  const oversized = 'x'.repeat(10_000);
  const brief = buildTeamBrief({ ...baseInput(), rollingContext: oversized }, files);
  assert.ok(
    !brief.includes(oversized),
    'the raw oversized rolling context never reaches the brief',
  );
  assert.match(brief, /truncated/);
});

test('runWorker: a multi-leaf fanout injects the shared team brief into every editor system prompt', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'lib/b.ts', kind: 'modify', purpose: 'fix b' },
    ],
    draftCommitMessage: 'feat: a + b',
  };
  const editorSystems: string[] = [];
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
      editorSystems.push(JSON.stringify(opts.prompt));
      return {
        content: [{ type: 'text', text: 'edited' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, { ...baseInput(), rollingContext: 'ROLL-CTX' });
  assert.equal(result.kind, 'ok');
  assert.equal(editorSystems.length, 2, 'two directories → two leaves');
  for (const sys of editorSystems) {
    assert.match(sys, /<team-brief>/, 'each editor sees the shared brief');
    assert.match(sys, /src\/a\.ts/, 'the brief lists the whole manifest, not just the leaf file');
    assert.match(sys, /lib\/b\.ts/);
    assert.match(sys, /task A/, 'the brief carries the task text');
    assert.match(sys, /ROLL-CTX/, 'the brief carries the rolling context');
  }
});

test('runWorker: a single-file manifest injects no team brief (single-leaf path byte-identical)', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  let editorPromptSeen = '';
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
      editorPromptSeen = JSON.stringify(opts.prompt);
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
  const result = await runWorker(agent, { ...baseInput(), rollingContext: 'ROLL-CTX' });
  assert.equal(result.kind, 'ok');
  assert.doesNotMatch(editorPromptSeen, /team-brief/, 'a lone leaf gets no team brief');
  assert.doesNotMatch(
    editorPromptSeen,
    /ROLL-CTX/,
    'the rolling context does not leak into a lone leaf',
  );
  assert.match(
    editorPromptSeen,
    /Make the change\. Reply with a one-line summary\./,
    'the per-file editor prompt is unchanged',
  );
});

test('runWorker: same-directory files collapse onto one leaf with no team brief', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'a' },
      { path: 'src/b.ts', kind: 'create', purpose: 'b' },
      { path: 'src/c.ts', kind: 'create', purpose: 'c' },
    ],
    draftCommitMessage: 'feat: abc',
  };
  const editorSystems: string[] = [];
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
      editorSystems.push(JSON.stringify(opts.prompt));
      return {
        content: [{ type: 'text', text: 'did abc' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools, calls } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.equal(
    editorSystems.length,
    1,
    'one directory (≤ cap) → a single leaf owns all three files',
  );
  assert.doesNotMatch(editorSystems[0] ?? '', /team-brief/, 'a lone leaf gets no brief');
  assert.match(editorSystems[0] ?? '', /You own these 3 files/, 'the leaf owns the whole group');
  assert.equal(calls.statuses.length, 3, 'each file in the group is verified on disk');
  if (result.kind === 'ok') {
    assert.deepEqual(
      result.delivery.changes.map((c) => c.path),
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    );
  }
});

test("runWorker: onEditorStepFinish is a per-leaf factory, called with each leaf's file/dir tag (issue #131)", async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/auth/login.ts', kind: 'create', purpose: 'login' },
      { path: 'src/auth/logout.ts', kind: 'create', purpose: 'logout' },
      { path: 'README.md', kind: 'modify', purpose: 'docs' },
    ],
    draftCommitMessage: 'feat: auth + docs',
  };
  const model = makeWorkerModel(manifest, ['did auth', 'did readme']);
  const { tools } = makeTools();
  const tagsRequested: string[] = [];
  const tagsAtStepFinish: string[] = [];
  const agent = createWorkerAgent({
    model,
    tools,
    systemPrompt: WORKER_SYSTEM_PREFIX,
    onEditorStepFinish: (editorTag: string) => {
      tagsRequested.push(editorTag);
      return () => {
        tagsAtStepFinish.push(editorTag);
      };
    },
  });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.deepEqual(
    [...tagsRequested].sort(),
    ['README.md', 'src/auth/'],
    'one leaf per directory: the two src/auth/ files collapse onto one leaf, README.md stands alone',
  );
  assert.deepEqual(
    [...tagsAtStepFinish].sort(),
    [...tagsRequested].sort(),
    'each leaf actually ran the handler this call built for it',
  );
});

test('runWorker: a multi-leaf fanout prints a roster + per-editor outcome line; a lone leaf stays silent (issue #131)', async () => {
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const manifest: FileManifest = {
      files: [
        { path: 'src/auth/login.ts', kind: 'create', purpose: 'login' },
        { path: 'src/auth/logout.ts', kind: 'create', purpose: 'logout' },
        { path: 'README.md', kind: 'modify', purpose: 'docs' },
      ],
      draftCommitMessage: 'feat: auth + docs',
    };
    const model = makeWorkerModel(manifest, ['did auth', 'did readme']);
    const { tools } = makeTools();
    const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
    const result = await runWorker(agent, baseInput());
    assert.equal(result.kind, 'ok');
    const roster = lines.find((l) => l.includes('fanning out 2 editors'));
    assert.ok(roster, 'roster line printed for a multi-leaf fanout');
    assert.match(
      roster ?? '',
      /src\/auth\/ \(2\), README\.md \(1\)|README\.md \(1\), src\/auth\/ \(2\)/,
    );
    assert.ok(
      lines.some((l) => l.includes('editor src/auth/ done — 2 changed')),
      'per-editor outcome line for the src/auth/ leaf',
    );
    assert.ok(
      lines.some((l) => l.includes('editor README.md done — 1 changed')),
      'per-editor outcome line for the README.md leaf',
    );
  } finally {
    process.stderr.write = realStderrWrite;
  }

  lines.length = 0;
  const lone: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'a' }],
    draftCommitMessage: 'feat: a',
  };
  const realStderrWrite2 = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const model = makeWorkerModel(lone);
    const { tools } = makeTools();
    const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
    const result = await runWorker(agent, baseInput());
    assert.equal(result.kind, 'ok');
    assert.ok(
      lines.every((l) => !l.includes('fanning out') && !l.includes('editor')),
      'a lone leaf stays silent — byte-identical to the pre-team fanout',
    );
  } finally {
    process.stderr.write = realStderrWrite2;
  }
});

test('runWorker: the editor fanout honors the concurrency cap (never more than the limit in flight)', async () => {
  // Four distinct directories → four leaves; cap the pool at 2 and prove no third leaf runs concurrently.
  const manifest: FileManifest = {
    files: [
      { path: 'a/f.ts', kind: 'create', purpose: 'a' },
      { path: 'b/f.ts', kind: 'create', purpose: 'b' },
      { path: 'c/f.ts', kind: 'create', purpose: 'c' },
      { path: 'd/f.ts', kind: 'create', purpose: 'd' },
    ],
    draftCommitMessage: 'feat: four dirs',
  };
  const { tools } = makeTools();
  let resolveBarrier!: () => void;
  const barrier = new Promise<void>((r) => {
    resolveBarrier = r;
  });
  let active = 0;
  let peak = 0;
  let editorCalls = 0;
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
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
      editorCalls++;
      active++;
      peak = Math.max(peak, active);
      await barrier;
      active--;
      return {
        content: [{ type: 'text', text: `edited #${idx}` }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const run = runWorker(agent, { ...baseInput(), editorConcurrency: 2 });
  // Wait for the first batch to launch; the barrier holds those leaves so no more than the cap can be
  // in flight at once. A broken (unbounded) pool would launch all four before any settle.
  for (let i = 0; i < 50 && editorCalls < 2; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
  assert.ok(editorCalls >= 2, 'the fanout launched its first batch');
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(peak, 2, 'never more than editorConcurrency=2 leaves in flight');
  resolveBarrier();
  const result = await run;
  assert.equal(result.kind, 'ok');
  assert.equal(editorCalls, 4, 'all four leaves ran');
  assert.equal(peak, 2, 'the cap held across the whole fanout');
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
        // Bare tree-wide status (the post-pass cleanup guard): clean by default so the verify-blocked
        // path skips reset/clean, byte-identical to today.
        if (path === '') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
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

// ---- verify gate: the formatter runs before the model ever sees a lint diagnostic ----

test('runWorker verify gate: a failed verify re-runs formatCommand and re-verifies BEFORE any model fix pass', async () => {
  // The observed waste: the verify gate failed on Biome formatting (an unexpanded `"exports"` field,
  // import order) and the harness handed those diagnostics straight to the model, which spawned four
  // editor leaves to hand-edit them. `biome check --write` fixes that whole class in ~200ms.
  const { model, submitCount } = makeManifestModel([{ at: 0, manifest: oneFileManifest }]);
  const { tools, bashes, verifies } = makeVerifyTools([1, 0]); // red, then green after the format
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, {
    ...baseInput(),
    formatCommand: 'biome check --write .',
    verifyCommand: 'run-verify',
  });
  assert.equal(result.kind, 'ok');

  assert.equal(submitCount(), 1, 'the formatter fixed it — no model fix pass was spent');
  assert.equal(verifies.length, 2, 'verify ran, then re-ran after the format');
  const cmds = bashes.map((b) => b.command);
  const formats = cmds
    .map((c, i) => (c.includes('biome check --write') ? i : -1))
    .filter((i) => i >= 0);
  const verifyIdxs = cmds.map((c, i) => (c.includes('run-verify') ? i : -1)).filter((i) => i >= 0);
  assert.equal(formats.length, 2, 'format ran before the first verify and again after it failed');
  assert.ok(
    (formats[1] ?? -1) > (verifyIdxs[0] ?? -1) && (formats[1] ?? -1) < (verifyIdxs[1] ?? -1),
    `the repair format sits between the two verifies, got ${cmds.join(' | ')}`,
  );
  assert.ok(
    cmds.some((c) => c.includes('commit -m')),
    'the formatted, re-verified change is committed',
  );
});

test('runWorker verify gate: only what the formatter cannot fix escalates to the single bounded fix pass', async () => {
  // red → format → still red → ONE model fix pass → format → green. The fix-pass semantics are
  // unchanged; the formatter just gets first refusal.
  const { model, prompts, submitCount } = makeManifestModel([
    { at: 0, manifest: oneFileManifest },
    { at: 2, manifest: fixManifest },
  ]);
  const { tools, verifies } = makeVerifyTools([1, 1, 0]);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, {
    ...baseInput(),
    formatCommand: 'biome check --write .',
    verifyCommand: 'run-verify',
  });
  assert.equal(result.kind, 'ok');
  assert.equal(verifies.length, 3, 'verify, format-repair re-verify, post-fix-pass re-verify');
  assert.equal(submitCount(), 2, 'still exactly one fix pass — the bound is unchanged');
  // The fix task is fed the SECOND (post-format) verify tail: whatever survived the formatter.
  assert.match(prompts[2] ?? '', /verify command failed/i);
  assert.match(prompts[2] ?? '', /VERIFY FAILED marker-1/);
});

test('runWorker verify gate: no formatCommand → a failed verify goes straight to the fix pass (unchanged)', async () => {
  const { model, submitCount } = makeManifestModel([
    { at: 0, manifest: oneFileManifest },
    { at: 2, manifest: fixManifest },
  ]);
  const { tools, verifies } = makeVerifyTools([1, 0]);
  const events: Array<Record<string, unknown>> = [];
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, {
    ...baseInput(),
    verifyCommand: 'run-verify',
    logger: makeCaptureLogger(events),
  });
  assert.equal(result.kind, 'ok');
  assert.equal(verifies.length, 2, 'no format-repair verify is inserted');
  assert.equal(submitCount(), 2, 'the fix pass ran, exactly as before');
  const verifyLogs = events.filter((e) => e.msg === 'worker: verify');
  assert.equal(verifyLogs[0]?.formatRetryFollowed, false);
  assert.equal(verifyLogs[0]?.fixPassFollowed, true);
});

test('runWorker verify gate: the format repair is logged and surfaced to the operator', async () => {
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const events: Array<Record<string, unknown>> = [];
  try {
    const { model } = makeManifestModel([{ at: 0, manifest: oneFileManifest }]);
    const { tools } = makeVerifyTools([1, 0]);
    const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
    const result = await runWorker(agent, {
      ...baseInput(),
      formatCommand: 'biome check --write .',
      verifyCommand: 'run-verify',
      logger: makeCaptureLogger(events),
    });
    assert.equal(result.kind, 'ok');
  } finally {
    process.stderr.write = realStderrWrite;
  }
  assert.ok(
    lines.some((l) => l.includes('verify failed → formatted → re-verified')),
    `the operator sees the format repair, got ${lines.join('')}`,
  );
  // One event per verify invocation still holds; the first one names the format repair as what followed.
  const verifyLogs = events.filter((e) => e.msg === 'worker: verify');
  assert.equal(verifyLogs.length, 2);
  assert.equal(verifyLogs[0]?.exitCode, 1);
  assert.equal(verifyLogs[0]?.formatRetryFollowed, true);
  assert.equal(
    verifyLogs[0]?.fixPassFollowed,
    false,
    'no model fix pass followed the first verify',
  );
  assert.equal(verifyLogs[1]?.exitCode, 0);
  assert.equal(verifyLogs[1]?.formatRetryFollowed, false);
  assert.equal(verifyLogs[1]?.fixPassFollowed, false);
});

// ---- fanout floor: trivial manifests run inline in one pass ----

const tiny = (path: string): FileManifestEntry => ({ path, kind: 'modify', purpose: 'one line' });

test('belowFanoutFloor: a handful of one-line modifications is below the floor', () => {
  assert.equal(belowFanoutFloor([tiny('a/x.ts'), tiny('b/y.ts')]), true);
  assert.equal(
    belowFanoutFloor([tiny('a/x.ts'), tiny('b/y.ts'), tiny('c/z.ts'), tiny('d/w.ts')]),
    true,
  );
});

test('belowFanoutFloor: a single-file manifest is already one leaf — nothing to collapse', () => {
  assert.equal(belowFanoutFloor([tiny('a/x.ts')]), false);
  assert.equal(belowFanoutFloor([]), false);
});

test('belowFanoutFloor: more than FANOUT_FLOOR_FILES entries still fans out', () => {
  const files = Array.from({ length: FANOUT_FLOOR_FILES + 1 }, (_v, i) => tiny(`d${i}/x.ts`));
  assert.equal(belowFanoutFloor(files), false);
});

test('belowFanoutFloor: any `create` keeps the fanout — writing a new file is never trivial', () => {
  assert.equal(
    belowFanoutFloor([tiny('a/x.ts'), { path: 'b/y.ts', kind: 'create', purpose: 'new' }]),
    false,
  );
});

test('belowFanoutFloor: substantial purposes keep the fanout even for two files', () => {
  const meaty = (path: string): FileManifestEntry => ({
    path,
    kind: 'modify',
    purpose: 'x'.repeat(200),
  });
  assert.equal(belowFanoutFloor([meaty('a/x.ts'), meaty('b/y.ts')]), false);
});

test('runWorker: four one-line edits run inline in ONE editor pass instead of four spawns', async () => {
  // The observed waste, verbatim: `fanning out 4 editors — db.test.ts (1), package.json #1 (1),
  // index.ts (1), package.json #2 (1)` — four agent spin-ups for four one-line edits.
  const manifest: FileManifest = {
    files: [
      tiny('a/db.test.ts'),
      tiny('b/package.json'),
      tiny('c/index.ts'),
      tiny('d/package.json'),
    ],
    draftCommitMessage: 'chore: four one-liners',
  };
  const editorPrompts: string[] = [];
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
      editorPrompts.push(JSON.stringify(opts.prompt));
      return {
        content: [{ type: 'text', text: 'did all four' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools, calls } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.equal(editorPrompts.length, 1, 'one editor pass, not four');
  assert.match(editorPrompts[0] ?? '', /You own these 4 files/);
  assert.doesNotMatch(editorPrompts[0] ?? '', /team-brief/, 'a collapsed leaf is not a team');
  assert.equal(calls.statuses.length, 4, 'every planned file is still phantom-guarded');
  if (result.kind === 'ok') {
    assert.deepEqual(
      result.delivery.changes.map((c) => c.path),
      ['a/db.test.ts', 'b/package.json', 'c/index.ts', 'd/package.json'],
    );
  }
});

test('runWorker: a manifest above the floor still fans out (the floor is a floor, not a ceiling)', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'a/x.ts', kind: 'create', purpose: 'a new module' },
      { path: 'b/y.ts', kind: 'modify', purpose: 'wire it in' },
    ],
    draftCommitMessage: 'feat: x + y',
  };
  let editorCalls = 0;
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
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
      editorCalls++;
      return {
        content: [{ type: 'text', text: 'edited' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.equal(editorCalls, 2, 'a create in the manifest keeps the two-leaf fanout');
});

test('runWorker: the `applied: true` inline path is untouched by the floor', async () => {
  const manifest: FileManifest = {
    files: [tiny('a/x.ts'), tiny('b/y.ts')],
    draftCommitMessage: 'chore: inline',
    applied: true,
  };
  let modelCalls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      modelCalls++;
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
    },
  });
  const { tools, calls } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.equal(modelCalls, 1, 'no editor pass at all — the Coordinator already wrote it');
  assert.equal(calls.statuses.length, 2, 'the inline phantom guard is unchanged');
});

// ---- manifest survey budget ----

test('readOnlyStreak: counts survey calls and resets on any write', () => {
  const step = (...names: string[]) => ({ toolCalls: names.map((toolName) => ({ toolName })) });
  assert.equal(readOnlyStreak([]), 0);
  assert.equal(readOnlyStreak([step('readFile', 'grep'), step('glob')]), 3);
  assert.equal(readOnlyStreak([step('readFile', 'writeFile'), step('glob')]), 1);
  assert.equal(readOnlyStreak([step('readFile', 'readFile'), step('editFile')]), 0);
  assert.equal(readOnlyStreak([step('multiEdit'), step('readFile')]), 1);
  // `bash` counts as survey: the observed spiral was `bash cat/ls/find` and `bun install` probing.
  assert.equal(readOnlyStreak([step('bash', 'bash', 'multiBash')]), 3);
});

test('surveyBudgetReminder: names the measurement and points at submit, without forbidding reads', () => {
  const reminder = surveyBudgetReminder(23);
  assert.match(reminder, /<system-reminder>[\s\S]*<\/system-reminder>/);
  assert.match(reminder, /23 read-only tool calls/);
  assert.match(reminder, /`submit`/);
  assert.doesNotMatch(reminder, /must not|do not read|forbidden/i);
});

test('runWorker: a manifest pass that only surveys gets one corrective nudge, then still submits', async () => {
  // Observed: ~40 read-only calls over 12 minutes before submitting a manifest for ONE file. Five
  // reads per step crosses MANIFEST_SURVEY_BUDGET without a single write.
  const perStep = 5;
  const surveySteps = Math.ceil(MANIFEST_SURVEY_BUDGET / perStep);
  const prompts: string[] = [];
  let step = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const idx = step++;
      prompts[idx] = JSON.stringify(opts.prompt);
      if (idx < surveySteps) {
        return {
          content: Array.from({ length: perStep }, (_v, n) => ({
            type: 'tool-call' as const,
            toolCallId: `read-${idx}-${n}`,
            toolName: 'readFile',
            input: JSON.stringify({ path: `src/f${idx}-${n}.ts` }),
          })),
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      if (idx === surveySteps) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'submit-late',
              toolName: 'submit',
              input: JSON.stringify(oneFileManifest),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      // The editor-fanout leaf (no submit tool) terminates by returning a plain text response — not
      // by exhausting a step cap, which is now the shared runaway backstop rather than a low bound.
      return {
        content: [{ type: 'text' as const, text: 'edited' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools, calls } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());

  assert.equal(calls.reads.length, MANIFEST_SURVEY_BUDGET, 'the survey actually ran');
  const nudged = prompts.findIndex((p) => p.includes('read-only tool calls in a row'));
  assert.equal(nudged, surveySteps, 'the nudge lands on the step that crosses the budget');
  assert.ok(
    prompts.slice(0, surveySteps).every((p) => !p.includes('read-only tool calls in a row')),
    'no nudge before the budget is crossed',
  );
  // It nudges, it never fails: the pass finishes and the manifest is honored.
  assert.equal(result.kind, 'ok');
});

test('runWorker: a manifest pass under the survey budget is never nudged', async () => {
  const prompts: string[] = [];
  let step = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const idx = step++;
      prompts[idx] = JSON.stringify(opts.prompt);
      if (idx === 0) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'read-0',
              toolName: 'readFile',
              input: JSON.stringify({ path: 'src/a.ts' }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      if (idx === 1) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'submit-0',
              toolName: 'submit',
              input: JSON.stringify(oneFileManifest),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: emptyUsage(),
          warnings: [],
        };
      }
      // Editor-fanout leaf: terminate via a text response, not the raised step backstop.
      return {
        content: [{ type: 'text' as const, text: 'edited' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.ok(
    prompts.every((p) => !p.includes('read-only tool calls in a row')),
    'a short survey is left alone',
  );
});

test('createWorkerAgent: the survey budget composes onto the caller prepareStep, it does not replace it', async () => {
  let baseCalls = 0;
  const { tools } = makeTools();
  const model = makeWorkerModel(oneFileManifest, ['created a']);
  const agent = createWorkerAgent({
    model,
    tools,
    systemPrompt: WORKER_SYSTEM_PREFIX,
    prepareStep: async () => {
      baseCalls++;
      return undefined;
    },
  });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.ok(baseCalls > 0, "the caller's prepareStep still runs");
});

// ---- phantom edit: one corrective retry before the whole task is blocked ----

test('runWorker: a leaf that narrated instead of writing is retried once and the task ships', async () => {
  // Observed: `group G2 task G2-3: → blocked, shipping partial PR (… no on-disk change for a planned
  // file: apps/api/src/routes/todos.ts …)` — the PR shipped services without its routes because one
  // leaf narrated. One corrective retry recovers it.
  const manifest: FileManifest = {
    files: [{ path: 'src/routes/todos.ts', kind: 'create', purpose: 'todo routes' }],
    draftCommitMessage: 'feat: todo routes',
  };
  const editorPrompts: string[] = [];
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
      editorPrompts.push(JSON.stringify(opts.prompt));
      return {
        content: [{ type: 'text', text: idx === 1 ? 'I updated the routes' : 'wrote the routes' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  // Clean on the first status query (narrated), dirty afterwards (the retry actually wrote it).
  const { tools, calls } = makeTools({ phantomOncePaths: ['src/routes/todos.ts'] });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.equal(editorPrompts.length, 2, 'exactly one corrective retry');
  assert.equal(calls.statuses.length, 2, 'the retried file is re-verified on disk');
  // The corrective prompt names the failure instead of re-issuing the same brief.
  assert.match(editorPrompts[1] ?? '', /wrote nothing/);
  assert.match(editorPrompts[1] ?? '', /src\/routes\/todos\.ts/);
  assert.match(editorPrompts[1] ?? '', /write\/edit tool/);
  if (result.kind === 'ok') {
    assert.deepEqual(result.delivery.changes, [
      { path: 'src/routes/todos.ts', kind: 'create', summary: 'wrote the routes' },
    ]);
  }
});

test('runWorker: a second narration after the corrective retry blocks — the retry is not repeated', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  const { tools, calls } = makeTools({ cleanStatusPaths: ['src/a.ts'] }); // never written
  let editorCalls = 0;
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
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
      editorCalls++;
      return {
        content: [{ type: 'text', text: 'pretended again' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'blocked');
  assert.equal(editorCalls, 2, 'one pass + exactly one retry, never a third');
  if (result.kind === 'blocked') assert.match(result.reason, /no on-disk change/i);
  assert.equal(
    calls.bashes.some((b) => /add -A|commit -m/.test(b.command)),
    false,
    'a doubly-narrated file still commits nothing',
  );
});

test('runWorker: a leaf that wrote everything is never retried (byte-identical happy path)', async () => {
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'src/b.ts', kind: 'create', purpose: 'create b' },
    ],
    draftCommitMessage: 'feat: a + b',
  };
  const { tools, calls } = makeTools();
  let editorCalls = 0;
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
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
      editorCalls++;
      return {
        content: [{ type: 'text', text: 'wrote both' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.equal(editorCalls, 1, 'no retry when nothing was phantom');
  assert.equal(calls.statuses.length, 2, 'one status check per planned file, no more');
});

test('buildPhantomRetryPrompt: names the failure and scopes to the unwritten files only', () => {
  const prompt = buildPhantomRetryPrompt(
    [{ path: 'src/routes/todos.ts', kind: 'create', purpose: 'todo routes' }],
    baseInput(),
  );
  assert.match(prompt, /wrote nothing/);
  assert.match(prompt, /unchanged on disk/);
  assert.match(prompt, /write\/edit tool/);
  assert.match(prompt, /src\/routes\/todos\.ts/);
  assert.match(prompt, /todo routes/);
  assert.doesNotMatch(prompt, /Make the change\. Reply with a one-line summary\./);
});

// ---- leaf hand-off: what the Coordinator already established reaches the leaves ----

test('runWorker: the manifest `sharedContext` reaches every leaf so it does not re-survey the repo', async () => {
  // Observed: four leaves each re-read repository.ts / todo.ts / errors.ts / biome.json /
  // package.json — the exact set the Coordinator had just finished reading during planning.
  const manifest: FileManifest = {
    files: [
      { path: 'src/a.ts', kind: 'create', purpose: 'create a' },
      { path: 'lib/b.ts', kind: 'modify', purpose: 'fix b' },
    ],
    draftCommitMessage: 'feat: a + b',
    sharedContext: 'repository.ts exposes findById at line 40; errors are AppError subclasses.',
  };
  const editorPrompts: string[] = [];
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
      editorPrompts.push(JSON.stringify(opts.prompt));
      return {
        content: [{ type: 'text', text: 'edited' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: emptyUsage(),
        warnings: [],
      };
    },
  });
  const { tools } = makeTools();
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.equal(editorPrompts.length, 2);
  for (const prompt of editorPrompts) {
    assert.match(prompt, /What the coordinator already established/);
    assert.match(prompt, /findById at line 40/);
  }
});

test('buildEditorPrompt via runWorker: verify/format facts reach the leaf; nothing to distil leaves the prompt untouched', async () => {
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  const capture = async (input: Partial<WorkerInput>): Promise<string> => {
    let editorPrompt = '';
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
        editorPrompt = JSON.stringify(opts.prompt);
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
    const result = await runWorker(agent, { ...baseInput(), ...input });
    assert.equal(result.kind, 'ok');
    return editorPrompt;
  };

  const withCommands = await capture({
    formatCommand: 'biome check --write .',
    verifyCommand: 'bun run test',
  });
  assert.match(withCommands, /must survive .bun run test./);
  assert.match(withCommands, /do not hand-fix formatting or import order/);

  const bare = await capture({});
  assert.doesNotMatch(bare, /What the coordinator already established/);
  assert.doesNotMatch(bare, /must survive/);
  assert.doesNotMatch(bare, /hand-fix formatting/);
  assert.match(
    bare,
    /Checkout: \/tmp\/wt\\nFile: src\/a\.ts/,
    'with nothing to distil the leaf prompt is byte-identical to the pre-hand-off shape',
  );
});

test('runWorker: an oversized sharedContext is capped before it is paid once per leaf', async () => {
  const oversized = 'C'.repeat(5_000);
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
    sharedContext: oversized,
  };
  let editorPrompt = '';
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
      editorPrompt = JSON.stringify(opts.prompt);
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
  const result = await runWorker(agent, baseInput());
  assert.equal(result.kind, 'ok');
  assert.ok(!editorPrompt.includes(oversized), 'the raw oversized digest never reaches a leaf');
  assert.match(editorPrompt, /truncated/);
});

test('buildManifestPrompt: the Coordinator is asked for the leaf hand-off digest', async () => {
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
  await runWorker(agent, baseInput());
  assert.match(sent, /sharedContext/);
  assert.match(sent, /they can read the rest themselves/);
});

test('runWorker: a self-review pass whose planner already edited every file skips the fanout', async () => {
  // The waste this closes, measured on a real run: the self-review Coordinator fixed a bug and wrote
  // its regression test with its own tools, submitted a manifest without `applied`, and the harness
  // fanned two editors out over finished work — ~70s for a net zero-line diff, one leaf reverting and
  // restoring a file just to re-prove a test it had not written.
  const manifest: FileManifest = {
    files: [
      { path: 'src/TodoItem.tsx', kind: 'modify', purpose: 'clear the draft in cancel()' },
      { path: 'test/TodoItem.test.tsx', kind: 'modify', purpose: 'Escape+blur regression test' },
    ],
    draftCommitMessage: 'fix: escape-cancel resurrects the draft',
  };
  const { tools, calls } = makeTools();
  // Only the manifest reply is scripted — an editor turn would have no model response to consume.
  const model = makeWorkerModel(manifest, []);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, { ...baseInput(), inlineEditsExpected: true });

  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  // Summaries come from the manifest's own `purpose`, which is the inline path's signature — the
  // fanout path harvests editor text instead.
  assert.deepEqual(result.delivery.changes, [
    { path: 'src/TodoItem.tsx', kind: 'modify', summary: 'clear the draft in cancel()' },
    { path: 'test/TodoItem.test.tsx', kind: 'modify', summary: 'Escape+blur regression test' },
  ]);
  assert.equal(calls.writes.length, 0, 'no editor leaf wrote anything');
});

test('runWorker: the inline inference is off for a normal task, which still fans out', async () => {
  // The normal path must keep planning and editing as distinct phases — a Coordinator that merely
  // looked at files does not get its manifest treated as executed.
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'create', purpose: 'create a' }],
    draftCommitMessage: 'feat: a',
  };
  const { tools } = makeTools();
  const model = makeWorkerModel(manifest, ['created a']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, baseInput());

  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(result.delivery.changes[0]?.summary, 'created a', 'the editor produced the summary');
});

test('runWorker: a planned file dirty BEFORE planning does not fool the inline skip — fanout runs', async () => {
  // The hole the pre-snapshot closes: a file inherited dirty (dirty before AND after) would pass the
  // "not dirty before" test and look newly edited, skipping the fanout on work this pass never did.
  const manifest: FileManifest = {
    files: [
      { path: 'src/TodoItem.tsx', kind: 'modify', purpose: 'fix a' },
      { path: 'test/TodoItem.test.tsx', kind: 'modify', purpose: 'test a' },
    ],
    draftCommitMessage: 'fix: a',
  };
  // src/TodoItem.tsx was already dirty when the task started; the editors must still run. The
  // fanout's summaries come from the editor text; the inline skip would use the manifest `purpose`
  // ('fix a'), so the summary source is the discriminator.
  const { tools } = makeTools({ preDirtyPaths: ['src/TodoItem.tsx'] });
  const model = makeWorkerModel(manifest, ['edited TodoItem', 'edited its test']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, { ...baseInput(), inlineEditsExpected: true });

  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  const summaries = result.delivery.changes.map((c) => c.summary);
  assert.ok(
    summaries.includes('edited TodoItem'),
    `fanout summaries expected, got inline purposes: ${JSON.stringify(summaries)}`,
  );
});

test('runWorker: a failed pre-planning snapshot disables the inline skip — fanout runs', async () => {
  // An unavailable baseline (git status errors) must NOT be read as an empty baseline; that would
  // make every inherited-dirty file look newly edited. A missing snapshot disables the inference.
  const manifest: FileManifest = {
    files: [{ path: 'src/a.ts', kind: 'modify', purpose: 'fix a' }],
    draftCommitMessage: 'fix: a',
  };
  const { tools } = makeTools({ preSnapshotFails: true });
  const model = makeWorkerModel(manifest, ['edited a']);
  const agent = createWorkerAgent({ model, tools, systemPrompt: WORKER_SYSTEM_PREFIX });

  const result = await runWorker(agent, { ...baseInput(), inlineEditsExpected: true });

  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  // Editor-produced summary ('edited a'), not the manifest purpose ('fix a') the inline skip uses.
  assert.equal(
    result.delivery.changes[0]?.summary,
    'edited a',
    'the fanout ran; summary from editor',
  );
});

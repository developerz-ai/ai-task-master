import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from 'ai';
import { z } from 'zod';
import type { PrGroup } from '../domain/pr-group.ts';
import type { Task } from '../domain/task.ts';
import {
  belowFanoutFloor,
  buildPhantomRetryPrompt,
  buildTeamBrief,
  EDITOR_TOOL_ALLOWLIST,
  editorToolSet,
  FANOUT_FLOOR_FILES,
  groupManifestByDir,
  labelEditorGroups,
  MAX_FILES_PER_EDITOR,
} from './editor-fanout.ts';
import type { FileManifestEntry, WorkerInput, WorkerTools } from './worker.ts';

function makeTools(): WorkerTools {
  return {
    readFile: tool({
      description: 'read a file from the checkout',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: '' }),
    }),
    writeFile: tool({
      description: 'write a file in the checkout',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ ok: true }),
    }),
    bash: tool({
      description: 'run a bash command in the checkout',
      inputSchema: z.object({ command: z.string() }),
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
  } as WorkerTools;
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
    reviewGraceApplied: false,
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

test('editorToolSet strips the runtime explore + memory + background extras so editors never nest surveys, touch memory, or manage background processes (issues #126/#118/#103)', () => {
  const stub = (desc: string) =>
    tool({ description: desc, inputSchema: z.object({ x: z.string() }), execute: async () => 'a' });
  // Reuse the complete WorkerTools fixture and add the runtime-only extras, exactly as the adapter
  // mounts them — no `as unknown as` bypass of the contract.
  const withExtras = {
    ...makeTools(),
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
  const tools = makeTools();
  const result = editorToolSet(tools);
  assert.equal('explore' in result, false, 'no explore to strip');
  assert.deepEqual(
    Object.keys(result).sort(),
    Object.keys(tools).sort(),
    'every original tool retained',
  );
});

test('editorToolSet excludes a runtime tool outside the allowlist by DEFAULT (issue #270)', () => {
  const stub = (desc: string) =>
    tool({ description: desc, inputSchema: z.object({ x: z.string() }), execute: async () => 'a' });
  // An extra the adapter might mount later — a future MCP-sourced or liveliness tool — that no
  // destructure line strips. The allowlist derivation drops it without anyone having to remember to.
  const withExtras = { ...makeTools(), mcpFoo: stub('mcp') };
  const stripped = editorToolSet(withExtras);
  assert.equal('mcpFoo' in stripped, false, 'an unknown runtime tool is excluded by default');
  assert.equal('readFile' in stripped, true, 'allowlisted tools retained');
});

test('EDITOR_TOOL_ALLOWLIST lists every WorkerTools field (allowlist is the full leaf surface, issue #270)', () => {
  // The runtime fixture is intentionally minimal, so completeness against the *type* is enforced at
  // compile time in editor-fanout.ts (`_allowlistCoversWorkerTools`). Here we pin the concrete list so
  // a future edit that drops a member is visible in review, and confirm no duplicates crept in.
  assert.deepEqual(
    [...EDITOR_TOOL_ALLOWLIST],
    [
      'readFile',
      'writeFile',
      'editFile',
      'multiEdit',
      'grep',
      'glob',
      'bash',
      'multiBash',
      'webFetch',
      'webSearch',
      'datetime',
    ],
  );
  assert.equal(new Set(EDITOR_TOOL_ALLOWLIST).size, EDITOR_TOOL_ALLOWLIST.length, 'no duplicates');
});

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

// ---- phantom retry prompt ----

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

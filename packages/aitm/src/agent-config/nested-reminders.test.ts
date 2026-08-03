// Paired coverage for nested-reminders.ts: which touch announces which nested file, and once.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localEditTools } from '../loop/tool-resolution.ts';
import type { NestedConfig } from './agent-config-detector.ts';
import { nestedConfigBlock, nestedConfigReminders, withNestedConfig } from './nested-reminders.ts';

const REPO = '/repo';

function nested(dir: string, contents = `rules for ${dir}`): NestedConfig {
  return { dir: join(REPO, dir), path: join(REPO, dir, 'CLAUDE.md'), contents };
}

// The provider's ctx shape; only `input` is read.
function touch(path: string): { toolCallId: string; input: unknown; output: unknown } {
  return { toolCallId: 't', input: { path }, output: {} };
}

test('announces a nested file the first time a file under it is touched', async () => {
  const provider = nestedConfigReminders([nested('packages/core')], REPO);

  assert.deepEqual(
    await provider(touch('README.md')),
    [],
    'a file outside the subtree says nothing',
  );

  const first = await provider(touch('packages/core/src/a.ts'));
  assert.equal(first?.length, 1);
  assert.match(first?.[0] ?? '', /packages\/core\/CLAUDE\.md/);
  assert.match(first?.[0] ?? '', /rules for packages\/core/);
});

test('announces once per file, not once per touch', async () => {
  // The block is repo instructions, not a per-call warning: repeating it every read would spend the
  // context window on the same text and drown the reminders that ARE per-call (#106 staleness).
  const provider = nestedConfigReminders([nested('apps/web')], REPO);
  assert.equal((await provider(touch('apps/web/a.ts')))?.length, 1);
  assert.deepEqual(await provider(touch('apps/web/b.ts')), []);
  assert.deepEqual(await provider(touch('apps/web/a.ts')), []);
});

test('a sibling directory with a matching prefix is not the same subtree', async () => {
  // `/repo/apps` must not claim `/repo/apps-legacy/x.ts` — a plain startsWith would.
  const provider = nestedConfigReminders([nested('apps')], REPO);
  assert.deepEqual(await provider(touch('apps-legacy/x.ts')), []);
  assert.equal((await provider(touch('apps/x.ts')))?.length, 1);
});

test('a nested file governs its whole subtree, however deep', async () => {
  const provider = nestedConfigReminders([nested('packages/core')], REPO);
  const out = await provider(touch('packages/core/src/deep/nested/a.ts'));
  assert.equal(out?.length, 1);
});

test('one touch announces every enclosing nested file, general → specific', async () => {
  // A file in packages/core/api is governed by BOTH packages/core and packages/core/api. Discovery
  // orders picks deepest last, and that order is preserved so the more specific block wins on
  // conflict — the same precedence the eager concatenation had.
  const provider = nestedConfigReminders(
    [nested('packages/core', 'CORE'), nested('packages/core/api', 'API')],
    REPO,
  );
  const out = await provider(touch('packages/core/api/routes.ts'));
  assert.equal(out?.length, 2);
  assert.match(out?.[0] ?? '', /CORE/);
  assert.match(out?.[1] ?? '', /API/);
});

test('a touch the tool did not name a path for announces nothing', async () => {
  const provider = nestedConfigReminders([nested('packages/core')], REPO);
  assert.deepEqual(await provider({ toolCallId: 't', input: {}, output: {} }), []);
  assert.deepEqual(await provider({ toolCallId: 't', input: null, output: {} }), []);
  assert.deepEqual(await provider({ toolCallId: 't', input: { path: 42 }, output: {} }), []);
});

test('an absolute touched path resolves the same as a repo-relative one', async () => {
  const provider = nestedConfigReminders([nested('packages/core')], REPO);
  assert.equal((await provider(touch(join(REPO, 'packages/core/a.ts'))))?.length, 1);
});

test('nestedConfigBlock names the file, the directory it governs, and why it arrived', () => {
  const block = nestedConfigBlock(nested('packages/core', 'CORE RULES'), REPO);
  assert.match(block, /Contents of packages\/core\/CLAUDE\.md/);
  assert.match(block, /instructions for files under packages\/core\//);
  assert.match(block, /because you just touched one/);
  assert.match(block, /CORE RULES/);
});

// Flatten a tool-result rendering to text, as tool-resolution.test.ts does for the same channel.
function renderedText(rendered: unknown): string {
  const r = rendered as { type: string; value: unknown };
  if (r.type === 'text') return r.value as string;
  if (r.type === 'content') {
    return (r.value as Array<{ type: string; text?: string }>)
      .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
      .join('\n');
  }
  return JSON.stringify(r.value);
}

// ---- withNestedConfig: the decorator over a resolved tool record ------------

test('withNestedConfig: no nested files → the record is returned untouched', () => {
  // The byte-identical guarantee: a repo without nested files must not even be decorated.
  const tools = localEditTools('/tmp/wt');
  assert.strictEqual(withNestedConfig(tools, [], '/tmp/wt'), tools);
});

test('withNestedConfig: a nested CLAUDE.md arrives on the first touch under it, once (issue #192)', async () => {
  // #117 concatenated this into the style digest up front, spending the budget on subtrees a run may
  // never open. It now arrives with the result of the call that entered the subtree.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-nested-'));
  try {
    const coreDir = join(dir, 'packages', 'core');
    await mkdir(coreDir, { recursive: true });
    await writeFile(join(coreDir, 'a.ts'), 'export const A = 1;\n');
    await writeFile(join(dir, 'README.md'), 'hi\n');
    const nested = [
      {
        dir: coreDir,
        path: join(coreDir, 'CLAUDE.md'),
        contents: '# core rules\n- no default exports\n',
      },
    ];
    const tools = withNestedConfig(localEditTools(dir), nested, dir);
    const render = async (path: string): Promise<string> =>
      renderedText(
        await tools.readFile.toModelOutput?.({
          toolCallId: 'call',
          input: { path },
          output: { content: '1\tfile body' },
        }),
      );

    assert.doesNotMatch(
      await render('README.md'),
      /no default exports/,
      'a file outside the subtree does not load its instructions',
    );
    assert.match(
      await render('packages/core/a.ts'),
      /no default exports/,
      'entering the subtree loads them',
    );
    assert.match(
      await render('packages/core/a.ts'),
      /file body/,
      'the tool result itself still renders',
    );
    assert.doesNotMatch(
      await render('packages/core/b.ts'),
      /no default exports/,
      'and they are not repeated on every later touch',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('withNestedConfig: grep and glob do not count as entering a subtree (issue #192)', () => {
  // They surface paths without reading them. A directory listing is not a visit, and treating it as
  // one would load every nested file in the repo on the Planner's first survey.
  const tools = localEditTools('/tmp/wt');
  const decorated = withNestedConfig(
    tools,
    [{ dir: '/tmp/wt/pkg', path: '/tmp/wt/pkg/CLAUDE.md', contents: 'x' }],
    '/tmp/wt',
  );
  assert.strictEqual(decorated.grep, tools.grep, 'grep is not decorated');
  assert.strictEqual(decorated.glob, tools.glob, 'glob is not decorated');
  assert.notStrictEqual(decorated.readFile, tools.readFile, 'readFile is');
});

test('withNestedConfig: a second decoration announces again — this is what scopes a leaf (issue #192)', async () => {
  // The Worker's editor leaves are built from the Coordinator's record (`editorToolSet(init.tools)`),
  // so without re-decorating, whichever agent enters the subtree first consumes the announcement and
  // the leaf that actually writes the code there never sees its conventions. Re-decorating a record
  // has to yield fresh state — that is the whole mechanism, so it is pinned here.
  const dir = await mkdtemp(join(tmpdir(), 'aitm-nested-leaf-'));
  try {
    const pkg = join(dir, 'pkg');
    await mkdir(pkg, { recursive: true });
    const nested = [{ dir: pkg, path: join(pkg, 'CLAUDE.md'), contents: '# pkg\n- tabs only\n' }];
    const render = async (tools: ReturnType<typeof localEditTools>): Promise<string> =>
      renderedText(
        await tools.readFile.toModelOutput?.({
          toolCallId: 'call',
          input: { path: 'pkg/a.ts' },
          output: { content: '1\tbody' },
        }),
      );

    const coordinator = withNestedConfig(localEditTools(dir), nested, dir);
    assert.match(await render(coordinator), /tabs only/, 'the coordinator is told');
    assert.doesNotMatch(await render(coordinator), /tabs only/, 'and not told twice');

    // The leaf re-decorates the SAME underlying record and must still be told.
    const leaf = withNestedConfig(coordinator, nested, dir);
    assert.match(await render(leaf), /tabs only/, 'the leaf gets its own announcement');
    assert.doesNotMatch(await render(leaf), /tabs only/, 'once, like everyone else');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

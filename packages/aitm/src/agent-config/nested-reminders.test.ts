// Paired coverage for nested-reminders.ts: which touch announces which nested file, and once.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { NestedConfig } from './agent-config-detector.ts';
import { nestedConfigBlock, nestedConfigReminders } from './nested-reminders.ts';

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

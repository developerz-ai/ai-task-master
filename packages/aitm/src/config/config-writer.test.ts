import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigWriter } from './config-writer.ts';

type Temp = { path: string; cleanup: () => Promise<void> };

async function tempDir(prefix: string): Promise<Temp> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function withWriter(
  fn: (ctx: { writer: ConfigWriter; home: string; cwd: string }) => Promise<void>,
): Promise<void> {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await fn({ writer: new ConfigWriter(cwd.path, home.path), home: home.path, cwd: cwd.path });
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
}

test('ConfigWriter is constructible', () => {
  const w = new ConfigWriter('/tmp/repo', '/tmp/home');
  assert.ok(w instanceof ConfigWriter);
});

test('set then get round-trips a JSON-encoded string', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'openrouterApiKey', '"sk-or-foo"');
    assert.equal(await writer.get('global', 'openrouterApiKey'), 'sk-or-foo');
  });
});

test('set parses JSON-encoded scalars (number, boolean, null)', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'maxPrs', '7');
    await writer.set('global', 'autoMerge', 'false');
    await writer.set('global', 'maxSessions', 'null');
    assert.equal(await writer.get('global', 'maxPrs'), 7);
    assert.equal(await writer.get('global', 'autoMerge'), false);
    assert.equal(await writer.get('global', 'maxSessions'), null);
  });
});

test('set accepts bare strings (JSON parse fallback)', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'mergeMethod', 'rebase');
    await writer.set('global', 'openrouterApiKey', 'sk-or-bare');
    assert.equal(await writer.get('global', 'mergeMethod'), 'rebase');
    assert.equal(await writer.get('global', 'openrouterApiKey'), 'sk-or-bare');
  });
});

test('set with a dotted key writes a nested object', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'models.smart', 'openai/o3');
    const file = await writer.list('global');
    assert.deepEqual(file.models, { smart: 'openai/o3' });
  });
});

test('set persists providerRouting.<field> and fallbackModels.<tier> as nested objects (issue #124)', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'providerRouting.sort', '"throughput"');
    await writer.set('global', 'providerRouting.order', '["anthropic","openai"]');
    await writer.set('global', 'fallbackModels.coding', '["a/x","b/y"]');
    const file = await writer.list('global');
    assert.deepEqual(file.providerRouting, { sort: 'throughput', order: ['anthropic', 'openai'] });
    assert.deepEqual(file.fallbackModels, { coding: ['a/x', 'b/y'] });
  });
});

test('set persists reasoningEffort.<tier> as a nested object (issue #125)', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'reasoningEffort.smart', '"high"');
    await writer.set('global', 'reasoningEffort.coding', '"medium"');
    const file = await writer.list('global');
    assert.deepEqual(file.reasoningEffort, { smart: 'high', coding: 'medium' });
  });
});

test('set rejects a bad reasoningEffort value via schema (issue #125)', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(
      () => writer.set('global', 'reasoningEffort.smart', '"maximum"'),
      /reasoningEffort/,
    );
  });
});

test('set then unset removes the key and persists', async () => {
  await withWriter(async ({ writer, home }) => {
    await writer.set('global', 'maxPrs', '4');
    await writer.unset('global', 'maxPrs');
    assert.equal(await writer.get('global', 'maxPrs'), undefined);
    const raw = await readFile(join(home, '.aitm.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.maxPrs, undefined);
  });
});

test('unset on a dotted key leaves siblings intact', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'models.smart', 'a');
    await writer.set('global', 'models.fast', 'b');
    await writer.unset('global', 'models.smart');
    const file = await writer.list('global');
    assert.equal(file.models?.smart, undefined);
    assert.equal(file.models?.fast, 'b');
  });
});

test('unset on a missing key is a no-op and returns the current file', async () => {
  await withWriter(async ({ writer }) => {
    const result = await writer.unset('global', 'maxPrs');
    assert.deepEqual(result, {});
  });
});

test('set rejects malformed scalar types via schema', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(() => writer.set('global', 'maxPrs', '"five"'), /maxPrs/);
    await assert.rejects(
      () => writer.set('global', 'mergeMethod', '"rebase-merge"'),
      /mergeMethod/,
    );
    await assert.rejects(() => writer.set('global', 'autoMerge', '"yes"'), /autoMerge/);
  });
});

test('set then get round-trips a baseURL', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'baseURL', 'https://api.z.ai/api/coding/paas/v4');
    assert.equal(await writer.get('global', 'baseURL'), 'https://api.z.ai/api/coding/paas/v4');
  });
});

test('set rejects a baseURL that is not a URL', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(() => writer.set('global', 'baseURL', 'not-a-url'), /baseURL/);
  });
});

test('set selfReview false succeeds (writer shares the schema key table)', async () => {
  await withWriter(async ({ writer }) => {
    await writer.set('global', 'selfReview', 'false');
    assert.equal(await writer.get('global', 'selfReview'), false);
  });
});

test('set accepts every schema key the old writer table omitted', async () => {
  // Keys the loader/schema recognized but `config set` used to reject — now settable via the one
  // shared CONFIG_KEYS table. Each value must also pass ConfigFileSchema on persist.
  const cases: ReadonlyArray<[string, string]> = [
    ['maxCiFixAttempts', '3'],
    ['llmStepTimeoutMs', '120000'],
    ['webSearch', 'false'],
    ['formatCommand', 'bun run lint:fix'],
    ['verifyCommand', 'bun test'],
    ['selfReview', 'false'],
    ['resolveConflicts', 'false'],
    ['allowForcePush', 'false'],
    ['bashRules', '[{"pattern":"rm -rf *","action":"deny"}]'],
    ['mcpRoleAllowlist', '{"worker":["filesystem"]}'],
    ['mcpDeferToolsOver', '0'],
    ['prBodySections', '["Summary","Changes"]'],
    ['hooks', '{"postToolUse":[{"command":"./x.sh"}]}'],
  ];
  await withWriter(async ({ writer }) => {
    for (const [key, value] of cases) {
      await writer.set('global', key, value);
    }
    const file = await writer.list('global');
    assert.equal(file.selfReview, false);
    assert.equal(file.allowForcePush, false);
    assert.equal(file.webSearch, false);
    assert.equal(file.maxCiFixAttempts, 3);
    assert.equal(file.mcpDeferToolsOver, 0);
    assert.deepEqual(file.prBodySections, ['Summary', 'Changes']);
    assert.deepEqual(file.hooks, { postToolUse: [{ command: './x.sh' }] });
  });
});

test('set rejects unknown top-level keys before any write', async () => {
  await withWriter(async ({ writer, home }) => {
    await assert.rejects(
      () => writer.set('global', 'futureKey', '"v"'),
      /Unknown config key "futureKey"/,
    );
    // file must not have been created
    const entries = await readdir(home);
    assert.deepEqual(entries, []);
  });
});

test('set rejects nested-key writes under an unknown top-level key', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(
      () => writer.set('global', 'futureKey.sub', '"v"'),
      /Unknown config key "futureKey"/,
    );
  });
});

test('set rejects empty/invalid keys', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(() => writer.set('global', '', '"v"'), /Invalid config key/);
    await assert.rejects(() => writer.set('global', 'models.', '"v"'), /Invalid config key/);
    await assert.rejects(() => writer.set('global', '.models', '"v"'), /Invalid config key/);
  });
});

test('set on project scope creates .ai-task-master/ parent dir', async () => {
  await withWriter(async ({ writer, cwd }) => {
    await writer.set('project', 'maxPrs', '3');
    const raw = await readFile(join(cwd, '.ai-task-master', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.maxPrs, 3);
  });
});

test('list returns the parsed file', async () => {
  await withWriter(async ({ writer, home }) => {
    await writeFile(
      join(home, '.aitm.json'),
      JSON.stringify({ maxPrs: 4, models: { smart: 'x' } }),
    );
    const file = await writer.list('global');
    assert.equal(file.maxPrs, 4);
    assert.equal(file.models?.smart, 'x');
  });
});

test('list returns {} when the file does not exist', async () => {
  await withWriter(async ({ writer }) => {
    assert.deepEqual(await writer.list('global'), {});
    assert.deepEqual(await writer.list('project'), {});
  });
});

test('list throws with file path on schema violation', async () => {
  await withWriter(async ({ writer, cwd }) => {
    const dir = join(cwd, '.ai-task-master');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), JSON.stringify({ maxPrs: 'not-a-number' }));
    await assert.rejects(() => writer.list('project'), /maxPrs/);
  });
});

test('atomic write leaves no .tmp file behind', async () => {
  await withWriter(async ({ writer, home }) => {
    await writer.set('global', 'maxPrs', '5');
    const entries = await readdir(home);
    assert.ok(!entries.some((e) => e.endsWith('.tmp')));
  });
});

test('set preserves unknown keys already in the file (forward-compat reads)', async () => {
  await withWriter(async ({ writer, home }) => {
    await writeFile(join(home, '.aitm.json'), JSON.stringify({ futureKey: 'keep' }));
    await writer.set('global', 'maxPrs', '6');
    const raw = await readFile(join(home, '.aitm.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.futureKey, 'keep');
    assert.equal(parsed.maxPrs, 6);
  });
});

test('set refuses profile-managed keys (activeProfile, profiles)', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(() => writer.set('global', 'activeProfile', 'z.ai'), /managed by/);
    await assert.rejects(
      () => writer.set('global', 'profiles.z.ai.baseURL', 'https://x.dev'),
      /managed by/,
    );
  });
});

test('unset refuses profile-managed keys', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(() => writer.unset('global', 'activeProfile'), /managed by/);
    await assert.rejects(() => writer.unset('global', 'profiles'), /managed by/);
  });
});

test('set rejects forbidden key segments (__proto__, prototype, constructor)', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(
      () => writer.set('global', 'models.__proto__.x', '"evil"'),
      /reserved segment/,
    );
    await assert.rejects(
      () => writer.set('global', 'models.prototype.x', '"evil"'),
      /reserved segment/,
    );
    await assert.rejects(
      () => writer.set('global', 'models.constructor.x', '"evil"'),
      /reserved segment/,
    );
  });
});

test('get rejects forbidden key segments', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(() => writer.get('global', 'models.__proto__'), /reserved segment/);
    await assert.rejects(() => writer.get('global', '__proto__'), /reserved segment/);
    await assert.rejects(() => writer.get('global', 'prototype'), /reserved segment/);
  });
});

test('unset rejects forbidden key segments', async () => {
  await withWriter(async ({ writer }) => {
    await assert.rejects(() => writer.unset('global', 'models.__proto__'), /reserved segment/);
    await assert.rejects(() => writer.unset('global', 'constructor'), /reserved segment/);
  });
});

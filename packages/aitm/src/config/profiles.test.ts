import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProfileManager } from './profiles.ts';

type Temp = { path: string; cleanup: () => Promise<void> };

async function tempHome(): Promise<Temp> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-home-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function withManager(fn: (ctx: { manager: ProfileManager; home: string }) => Promise<void>) {
  const home = await tempHome();
  try {
    await fn({ manager: new ProfileManager(home.path), home: home.path });
  } finally {
    await home.cleanup();
  }
}

async function readGlobal(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(home, '.aitm.json'), 'utf8'));
}

test('ProfileManager is constructible', () => {
  assert.ok(new ProfileManager('/tmp/home') instanceof ProfileManager);
});

test('list returns empty when no config file exists', async () => {
  await withManager(async ({ manager }) => {
    const listing = await manager.list();
    assert.equal(listing.activeProfile, undefined);
    assert.deepEqual(listing.profiles, {});
  });
});

test('add with preset seeds baseURL + models from the preset', async () => {
  await withManager(async ({ manager }) => {
    const profile = await manager.add('z.ai', { preset: 'zai' });
    assert.equal(profile.baseURL, 'https://api.z.ai/api/coding/paas/v4');
    assert.equal(profile.models?.coding, 'glm-5.2');
  });
});

test('add auto-activates the first profile, leaves active alone for later adds', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    assert.equal((await manager.list()).activeProfile, 'z.ai');
    await manager.add('openrouter', { preset: 'openrouter' });
    assert.equal((await manager.list()).activeProfile, 'z.ai', 'second add must not steal active');
  });
});

test('add applies explicit --api-key / --base-url over the preset', async () => {
  await withManager(async ({ manager }) => {
    const p = await manager.add('z.ai', {
      preset: 'zai',
      apiKey: 'sk-or-explicit',
      baseURL: 'https://proxy.example/v1',
    });
    assert.equal(p.openrouterApiKey, 'sk-or-explicit');
    assert.equal(p.baseURL, 'https://proxy.example/v1');
  });
});

test('add rejects a duplicate profile name', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await assert.rejects(() => manager.add('z.ai'), /already exists/);
  });
});

test('add rejects an empty profile name', async () => {
  await withManager(async ({ manager }) => {
    await assert.rejects(() => manager.add('  '), /non-empty/);
  });
});

test('use switches the active profile', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.add('openrouter', { preset: 'openrouter' });
    await manager.use('openrouter');
    assert.equal((await manager.list()).activeProfile, 'openrouter');
  });
});

test('use rejects an unknown profile (no dangling pointer)', async () => {
  await withManager(async ({ manager }) => {
    await assert.rejects(() => manager.use('ghost'), /Unknown profile "ghost"/);
  });
});

test('set updates a nested models tier; get reads it back', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.set('z.ai', 'models.fast', 'glm-5-turbo');
    await manager.set('z.ai', 'openrouterApiKey', 'sk-or-set');
    assert.equal(await manager.get('z.ai', 'models.fast'), 'glm-5-turbo');
    assert.equal(await manager.get('z.ai', 'openrouterApiKey'), 'sk-or-set');
  });
});

test('set persists providerRouting.<field> and fallbackModels.<tier>; get reads them back (issue #124)', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.set('z.ai', 'providerRouting.order', '["anthropic","openai"]');
    await manager.set('z.ai', 'fallbackModels.coding', '["a/x"]');
    assert.deepEqual(await manager.get('z.ai', 'providerRouting.order'), ['anthropic', 'openai']);
    assert.deepEqual(await manager.get('z.ai', 'fallbackModels.coding'), ['a/x']);
  });
});

test('set persists reasoningEffort.<tier>; get reads it back (issue #125)', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.set('z.ai', 'reasoningEffort.smart', 'high');
    await manager.set('z.ai', 'reasoningEffort.coding', 'medium');
    assert.equal(await manager.get('z.ai', 'reasoningEffort.smart'), 'high');
    assert.equal(await manager.get('z.ai', 'reasoningEffort.coding'), 'medium');
  });
});

test('set rejects an off-surface reasoningEffort path and a bad effort value (issue #125)', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await assert.rejects(
      () => manager.set('z.ai', 'reasoningEffort', 'high'),
      /Invalid profile key/,
    );
    await assert.rejects(
      () => manager.set('z.ai', 'reasoningEffort.smart.deep', 'high'),
      /Invalid profile key/,
    );
    await assert.rejects(() => manager.set('z.ai', 'reasoningEffort.smart', 'maximum'));
  });
});

test('set rejects an off-surface providerRouting/fallbackModels path (too deep) (issue #124)', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await assert.rejects(
      () => manager.set('z.ai', 'providerRouting.bogus.deep', 'x'),
      /Invalid profile key/,
    );
    await assert.rejects(() => manager.set('z.ai', 'providerRouting', 'x'), /Invalid profile key/);
    await assert.rejects(
      () => manager.set('z.ai', 'fallbackModels.coding.deep', 'x'),
      /Invalid profile key/,
    );
  });
});

test('set rejects a value that breaks the schema (non-URL baseURL)', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await assert.rejects(() => manager.set('z.ai', 'baseURL', 'not-a-url'));
  });
});

test('set rejects an unknown profile', async () => {
  await withManager(async ({ manager }) => {
    await assert.rejects(() => manager.set('ghost', 'baseURL', 'https://x.dev'), /Unknown profile/);
  });
});

test('set rejects prototype-polluting key paths and leaves Object.prototype intact', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    for (const key of ['__proto__.polluted', 'constructor.prototype.x', 'prototype.y']) {
      await assert.rejects(() => manager.set('z.ai', key, 'boom'), /Invalid profile key/);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

test('set rejects keys outside the documented surface', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await assert.rejects(() => manager.set('z.ai', 'maxPrs', '9'), /Invalid profile key/);
    await assert.rejects(
      () => manager.set('z.ai', 'models.smart.deep', 'x'),
      /Invalid profile key/,
    );
    await assert.rejects(() => manager.set('z.ai', 'models', 'x'), /Invalid profile key/);
  });
});

const RESERVED_NAMES = ['__proto__', 'prototype', 'constructor'];

test('every command rejects a reserved profile name and leaves Object.prototype intact', async () => {
  await withManager(async ({ manager, home }) => {
    await manager.add('z.ai', { preset: 'zai' });
    for (const name of RESERVED_NAMES) {
      await assert.rejects(() => manager.add(name), /Invalid profile name/);
      await assert.rejects(() => manager.use(name), /Invalid profile name/);
      await assert.rejects(
        () => manager.set(name, 'baseURL', 'https://evil.example/v1'),
        /Invalid profile name/,
      );
      await assert.rejects(() => manager.get(name, 'baseURL'), /Invalid profile name/);
      await assert.rejects(() => manager.remove(name), /Invalid profile name/);
      await assert.rejects(() => manager.show(name), /Invalid profile name/);
    }
    assert.equal(({} as Record<string, unknown>).baseURL, undefined, 'Object.prototype polluted');
    const file = await readGlobal(home);
    assert.deepEqual(Object.keys(file.profiles as object), ['z.ai']);
    assert.equal(file.activeProfile, 'z.ai');
  });
});

test('membership is own-property only — an inherited name is not an existing profile', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await assert.rejects(() => manager.use('toString'), /Unknown profile "toString"/);
    await assert.rejects(() => manager.set('toString', 'baseURL', 'https://x.dev/v1'), /Unknown/);
    await assert.rejects(() => manager.get('toString', 'baseURL'), /Unknown/);
    await assert.rejects(() => manager.remove('toString'), /Unknown/);
    await assert.rejects(() => manager.show('toString'), /Unknown/);
  });
});

test('add accepts a name that merely shadows an inherited key', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('toString', { baseURL: 'https://x.dev/v1' });
    assert.equal(await manager.get('toString', 'baseURL'), 'https://x.dev/v1');
    assert.deepEqual(Object.keys((await manager.list()).profiles), ['toString']);
  });
});

test('a hand-edited __proto__ profile key is unreachable and dropped on the next write', async () => {
  await withManager(async ({ manager, home }) => {
    await writeFile(
      join(home, '.aitm.json'),
      '{"profiles":{"__proto__":{"baseURL":"https://evil.example/v1"}}}',
    );
    assert.deepEqual((await manager.list()).profiles, {});
    await assert.rejects(() => manager.use('__proto__'), /Invalid profile name/);
    await manager.add('z.ai', { preset: 'zai' });
    const file = await readGlobal(home);
    assert.deepEqual(Object.keys(file.profiles as object), ['z.ai']);
    assert.equal(({} as Record<string, unknown>).baseURL, undefined, 'Object.prototype polluted');
  });
});

test('remove deletes the profile and clears active when it was active', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.remove('z.ai');
    const listing = await manager.list();
    assert.equal(listing.activeProfile, undefined);
    assert.deepEqual(listing.profiles, {});
  });
});

test('remove keeps active pointer when a different profile is removed', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.add('openrouter', { preset: 'openrouter' });
    await manager.remove('openrouter');
    assert.equal((await manager.list()).activeProfile, 'z.ai');
  });
});

test('remove rejects an unknown profile', async () => {
  await withManager(async ({ manager }) => {
    await assert.rejects(() => manager.remove('ghost'), /Unknown profile/);
  });
});

test('rename keeps every field and returns the profile under the new name', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai', apiKey: 'sk-or-secret' });
    const renamed = await manager.rename('z.ai', 'zed');
    assert.equal(renamed.baseURL, 'https://api.z.ai/api/coding/paas/v4');
    assert.equal(renamed.openrouterApiKey, 'sk-or-secret');
    const listing = await manager.list();
    assert.deepEqual(Object.keys(listing.profiles), ['zed']);
  });
});

test('rename repoints activeProfile at the new name when the renamed profile was active', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.rename('z.ai', 'zed');
    assert.equal((await manager.list()).activeProfile, 'zed');
  });
});

test('rename leaves activeProfile alone when a different profile is renamed', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.add('openrouter', { preset: 'openrouter' });
    await manager.rename('openrouter', 'or2');
    assert.equal((await manager.list()).activeProfile, 'z.ai');
  });
});

test('rename rejects an unknown source profile', async () => {
  await withManager(async ({ manager }) => {
    await assert.rejects(() => manager.rename('ghost', 'new'), /Unknown profile/);
  });
});

test('rename rejects a destination name that already exists', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await manager.add('openrouter', { preset: 'openrouter' });
    await assert.rejects(() => manager.rename('z.ai', 'openrouter'), /already exists/);
  });
});

test('rename to the same name is a no-op that still returns the profile', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    const result = await manager.rename('z.ai', 'z.ai');
    assert.equal(result.baseURL, 'https://api.z.ai/api/coding/paas/v4');
    assert.deepEqual(Object.keys((await manager.list()).profiles), ['z.ai']);
  });
});

test('rename rejects a reserved name on either side', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    await assert.rejects(() => manager.rename('z.ai', '__proto__'), /reserved word/);
    await assert.rejects(() => manager.rename('__proto__', 'z.ai'), /reserved word/);
  });
});

test('show defaults to the active profile', async () => {
  await withManager(async ({ manager }) => {
    await manager.add('z.ai', { preset: 'zai' });
    const { name } = await manager.show();
    assert.equal(name, 'z.ai');
  });
});

test('show errors when no name and no active profile', async () => {
  await withManager(async ({ manager }) => {
    await assert.rejects(() => manager.show(), /No profile specified/);
  });
});

test('profile mutations never touch unrelated top-level config', async () => {
  await withManager(async ({ manager, home }) => {
    await writeFile(
      join(home, '.aitm.json'),
      JSON.stringify({ maxPrs: 9, autoMerge: false, models: { smart: 'x/y' } }),
    );
    await manager.add('z.ai', { preset: 'zai', apiKey: 'sk-or-k' });
    const file = await readGlobal(home);
    assert.equal(file.maxPrs, 9);
    assert.equal(file.autoMerge, false);
    assert.deepEqual(file.models, { smart: 'x/y' });
    assert.equal(file.activeProfile, 'z.ai');
  });
});

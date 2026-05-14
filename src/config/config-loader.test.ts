import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODELS } from '../credentials/defaults.ts';
import { ConfigLoader } from './config-loader.ts';

type Temp = { path: string; cleanup: () => Promise<void> };

async function tempDir(prefix: string): Promise<Temp> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function writeGlobalConfig(home: string, contents: unknown): Promise<void> {
  await writeFile(join(home, '.aitm.json'), JSON.stringify(contents));
}

async function writeProjectConfig(cwd: string, contents: unknown): Promise<void> {
  const dir = join(cwd, '.ai-task-master');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify(contents));
}

function makeWarnCollector(): { calls: string[]; warn: (m: string) => void } {
  const calls: string[] = [];
  return { calls, warn: (m) => calls.push(m) };
}

test('ConfigLoader is constructible', () => {
  const loader = new ConfigLoader('/tmp/repo', '/tmp/home', {});
  assert.ok(loader instanceof ConfigLoader);
});

test('resolve: uses built-in defaults when only env key is set', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    const loader = new ConfigLoader(cwd.path, home.path, { OPENROUTER_API_KEY: 'sk-env' });
    const resolved = await loader.resolve({});
    assert.equal(resolved.openrouterApiKey, 'sk-env');
    assert.equal(resolved.apiKeySource, 'env');
    assert.equal(resolved.maxPrs, 5);
    assert.equal(resolved.maxSessions, null);
    assert.equal(resolved.autoMerge, true);
    assert.equal(resolved.mergeMethod, 'squash');
    assert.equal(resolved.stylePath, null);
    assert.equal(resolved.logLevel, 'info');
    assert.equal(resolved.concurrency, 1);
    assert.deepEqual(resolved.models, DEFAULT_MODELS);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('resolve: throws when no API key in any source', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    const loader = new ConfigLoader(cwd.path, home.path, {});
    await assert.rejects(() => loader.resolve({}), /No OpenRouter API key/);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('resolve: project file beats global file for API key and scalar fields', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await writeGlobalConfig(home.path, {
      openrouterApiKey: 'sk-global',
      maxPrs: 7,
      autoMerge: false,
    });
    await writeProjectConfig(cwd.path, {
      openrouterApiKey: 'sk-project',
      maxPrs: 9,
    });
    const loader = new ConfigLoader(cwd.path, home.path, { OPENROUTER_API_KEY: 'sk-env' });
    const resolved = await loader.resolve({});
    assert.equal(resolved.openrouterApiKey, 'sk-project');
    assert.equal(resolved.apiKeySource, 'project');
    assert.equal(resolved.maxPrs, 9);
    // autoMerge only in global → inherited
    assert.equal(resolved.autoMerge, false);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('resolve: global key used when project file has no openrouterApiKey', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await writeGlobalConfig(home.path, { openrouterApiKey: 'sk-global' });
    await writeProjectConfig(cwd.path, { maxPrs: 3 });
    const loader = new ConfigLoader(cwd.path, home.path, {});
    const resolved = await loader.resolve({});
    assert.equal(resolved.openrouterApiKey, 'sk-global');
    assert.equal(resolved.apiKeySource, 'global');
    assert.equal(resolved.maxPrs, 3);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('resolve: apiKeySource=env only when project + global have no key', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await writeGlobalConfig(home.path, { maxPrs: 2 });
    await writeProjectConfig(cwd.path, { autoMerge: false });
    const loader = new ConfigLoader(cwd.path, home.path, { OPENROUTER_API_KEY: 'sk-env' });
    const resolved = await loader.resolve({});
    assert.equal(resolved.openrouterApiKey, 'sk-env');
    assert.equal(resolved.apiKeySource, 'env');
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('resolve: CLI overrides beat project + global', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await writeGlobalConfig(home.path, {
      openrouterApiKey: 'sk-global',
      maxPrs: 2,
      concurrency: 3,
    });
    await writeProjectConfig(cwd.path, { maxPrs: 4, autoMerge: false });
    const loader = new ConfigLoader(cwd.path, home.path, {});
    const resolved = await loader.resolve({
      maxPrs: 11,
      autoMerge: true,
      mergeMethod: 'rebase',
      concurrency: 7,
    });
    assert.equal(resolved.maxPrs, 11);
    assert.equal(resolved.autoMerge, true);
    assert.equal(resolved.mergeMethod, 'rebase');
    assert.equal(resolved.concurrency, 7);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('resolve: CLI --model pins generic tier; other tiers inherit project/defaults', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await writeProjectConfig(cwd.path, {
      openrouterApiKey: 'sk-p',
      models: { smart: 'project/smart-model' },
    });
    const loader = new ConfigLoader(cwd.path, home.path, {});
    const resolved = await loader.resolve({ model: 'cli/pinned-model' });
    assert.equal(resolved.models.generic, 'cli/pinned-model');
    assert.equal(resolved.models.smart, 'project/smart-model');
    assert.equal(resolved.models.coding, DEFAULT_MODELS.coding);
    assert.equal(resolved.models.fast, DEFAULT_MODELS.fast);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('resolve: explicit null in CLI overrides defeats project/global value', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await writeProjectConfig(cwd.path, {
      openrouterApiKey: 'sk-p',
      stylePath: '/some/path',
      maxSessions: 10,
    });
    const loader = new ConfigLoader(cwd.path, home.path, {});
    const resolved = await loader.resolve({ stylePath: null, maxSessions: null });
    assert.equal(resolved.stylePath, null);
    assert.equal(resolved.maxSessions, null);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('resolve: unknown keys produce a warning and the parse continues', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  const { calls, warn } = makeWarnCollector();
  try {
    await writeProjectConfig(cwd.path, {
      openrouterApiKey: 'sk-p',
      maxPrs: 6,
      futureKey: 'whatever',
    });
    const loader = new ConfigLoader(cwd.path, home.path, {}, { warn });
    const resolved = await loader.resolve({});
    assert.equal(resolved.maxPrs, 6);
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /unknown config key "futureKey"/);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('readGlobal returns null when ~/.aitm.json is missing', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    const loader = new ConfigLoader(cwd.path, home.path, {});
    assert.equal(await loader.readGlobal(), null);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('readProject returns null when .ai-task-master/config.json is missing', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    const loader = new ConfigLoader(cwd.path, home.path, {});
    assert.equal(await loader.readProject(), null);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('readProject throws with file path on invalid JSON', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    const dir = join(cwd.path, '.ai-task-master');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), '{not-json');
    const loader = new ConfigLoader(cwd.path, home.path, {});
    await assert.rejects(() => loader.readProject(), /config\.json: invalid JSON/);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('readProject throws with file path on schema violation', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await writeProjectConfig(cwd.path, { maxPrs: 'not-a-number' });
    const loader = new ConfigLoader(cwd.path, home.path, {});
    await assert.rejects(() => loader.readProject(), /maxPrs/);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('writeSnapshot writes config.snapshot.json with API key replaced by source label', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    const loader = new ConfigLoader(cwd.path, home.path, { OPENROUTER_API_KEY: 'sk-very-secret' });
    const resolved = await loader.resolve({});
    const stateDir = join(cwd.path, '.ai-task-master');
    await mkdir(stateDir, { recursive: true });
    await loader.writeSnapshot(resolved, stateDir);
    const raw = await readFile(join(stateDir, 'config.snapshot.json'), 'utf8');
    assert.doesNotMatch(raw, /sk-very-secret/);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.apiKeySource, 'env');
    assert.match(String(parsed.openrouterApiKey), /env/);
    assert.equal(parsed.maxPrs, 5);
    assert.equal(parsed.autoMerge, true);
    // tmp file should have been renamed away
    const entries = await readdir(stateDir);
    assert.ok(!entries.includes('config.snapshot.json.tmp'));
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

test('writeSnapshot preserves apiKeySource=project label when project supplied key', async () => {
  const home = await tempDir('aitm-home-');
  const cwd = await tempDir('aitm-cwd-');
  try {
    await writeProjectConfig(cwd.path, { openrouterApiKey: 'sk-proj' });
    const loader = new ConfigLoader(cwd.path, home.path, {});
    const resolved = await loader.resolve({});
    const stateDir = join(cwd.path, '.ai-task-master');
    await loader.writeSnapshot(resolved, stateDir);
    const raw = await readFile(join(stateDir, 'config.snapshot.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(parsed.apiKeySource, 'project');
    assert.match(String(parsed.openrouterApiKey), /project/);
    assert.doesNotMatch(raw, /sk-proj/);
  } finally {
    await home.cleanup();
    await cwd.cleanup();
  }
});

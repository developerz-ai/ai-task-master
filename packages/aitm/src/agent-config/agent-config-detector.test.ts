import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempRepo } from '../testing/temp-repo.ts';
import { AgentConfigDetector } from './agent-config-detector.ts';

test('AgentConfigDetector is constructible', () => {
  const d = new AgentConfigDetector('/tmp/repo');
  assert.ok(d instanceof AgentConfigDetector);
});

test('detect: --style path → flavor custom (absolute path)', async () => {
  const repo = await makeTempRepo();
  try {
    const stylePath = join(repo.path, 'docs', 'style.md');
    await writeFile(join(repo.path, 'CLAUDE.md'), '# claude\n'); // must be ignored
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(repo.path, 'docs'), { recursive: true });
    await writeFile(stylePath, '# custom style\n');
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({ stylePath });
    assert.ok(cfg);
    assert.equal(cfg.flavor, 'custom');
    assert.equal(cfg.path, stylePath);
    assert.equal(cfg.contents, '# custom style\n');
  } finally {
    await repo.cleanup();
  }
});

test('detect: --style path → flavor custom (relative path resolved against repoRoot)', async () => {
  const repo = await makeTempRepo();
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(repo.path, 'docs'), { recursive: true });
    await writeFile(join(repo.path, 'docs', 'style.md'), '# rel\n');
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({ stylePath: 'docs/style.md' });
    assert.ok(cfg);
    assert.equal(cfg.flavor, 'custom');
    assert.equal(cfg.path, join(repo.path, 'docs', 'style.md'));
    assert.equal(cfg.contents, '# rel\n');
  } finally {
    await repo.cleanup();
  }
});

test('detect: --style path that does not exist → throws', async () => {
  const repo = await makeTempRepo();
  try {
    const d = new AgentConfigDetector(repo.path);
    await assert.rejects(() => d.detect({ stylePath: 'missing.md' }));
  } finally {
    await repo.cleanup();
  }
});

test('detect: relative --style path escaping repoRoot → throws', async () => {
  const repo = await makeTempRepo();
  try {
    const d = new AgentConfigDetector(repo.path);
    await assert.rejects(
      () => d.detect({ stylePath: '../outside.md' }),
      /must remain within repoRoot/,
    );
  } finally {
    await repo.cleanup();
  }
});

test('detect: only CLAUDE.md → flavor claude', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({});
    assert.ok(cfg);
    assert.equal(cfg.flavor, 'claude');
    assert.equal(cfg.path, join(repo.path, 'CLAUDE.md'));
    assert.equal(cfg.contents, '# CLAUDE.md\n');
  } finally {
    await repo.cleanup();
  }
});

test('detect: only AGENTS.md → flavor agents', async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.path, 'AGENTS.md'), '# agents\n');
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({});
    assert.ok(cfg);
    assert.equal(cfg.flavor, 'agents');
    assert.equal(cfg.path, join(repo.path, 'AGENTS.md'));
    assert.equal(cfg.contents, '# agents\n');
  } finally {
    await repo.cleanup();
  }
});

test('detect: both present → prefer claude by default', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await writeFile(join(repo.path, 'AGENTS.md'), '# agents\n');
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({});
    assert.ok(cfg);
    assert.equal(cfg.flavor, 'claude');
    assert.equal(cfg.path, join(repo.path, 'CLAUDE.md'));
  } finally {
    await repo.cleanup();
  }
});

test('detect: both present + prefer agents → flavor agents', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await writeFile(join(repo.path, 'AGENTS.md'), '# agents\n');
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({ prefer: 'agents' });
    assert.ok(cfg);
    assert.equal(cfg.flavor, 'agents');
    assert.equal(cfg.path, join(repo.path, 'AGENTS.md'));
    assert.equal(cfg.contents, '# agents\n');
  } finally {
    await repo.cleanup();
  }
});

test('detect: both present + prefer claude (explicit) → flavor claude', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await writeFile(join(repo.path, 'AGENTS.md'), '# agents\n');
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({ prefer: 'claude' });
    assert.ok(cfg);
    assert.equal(cfg.flavor, 'claude');
  } finally {
    await repo.cleanup();
  }
});

test('detect: neither present and no --style → null', async () => {
  const repo = await makeTempRepo();
  try {
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({});
    assert.equal(cfg, null);
  } finally {
    await repo.cleanup();
  }
});

test('detect: --style takes precedence over CLAUDE.md/AGENTS.md', async () => {
  const repo = await makeTempRepo({ withClaudeMd: true });
  try {
    await writeFile(join(repo.path, 'AGENTS.md'), '# agents\n');
    await writeFile(join(repo.path, 'style.md'), '# override\n');
    const d = new AgentConfigDetector(repo.path);
    const cfg = await d.detect({ stylePath: 'style.md' });
    assert.ok(cfg);
    assert.equal(cfg.flavor, 'custom');
    assert.equal(cfg.contents, '# override\n');
  } finally {
    await repo.cleanup();
  }
});

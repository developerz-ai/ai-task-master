import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTempRepo } from '../testing/temp-repo.ts';
import {
  AgentConfigDetector,
  DEFAULT_STYLE_CONTENTS,
  defaultAgentConfig,
} from './agent-config-detector.ts';

async function tempUserDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-userhome-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

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

test('defaultAgentConfig: a generic custom-flavor config for a repo with no style file', () => {
  // The CLI falls back to this (rather than aborting) when detect() returns null, so aitm runs on a
  // bare repo. flavor 'custom' maps to state.json agentConfigFile 'custom'; path is empty (no file).
  const cfg = defaultAgentConfig();
  assert.equal(cfg.flavor, 'custom');
  assert.equal(cfg.path, '');
  assert.deepEqual(cfg.sources, []);
  assert.equal(cfg.contents, DEFAULT_STYLE_CONTENTS);
  assert.match(cfg.contents, /# Coding Style/);
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

// ---- layered discovery (issue #117) ----

test('detect: user-global + root → labeled blocks general→specific; nested is held back (#192)', async () => {
  const repo = await makeTempRepo();
  const user = await tempUserDir();
  try {
    await writeFile(join(user.path, 'CLAUDE.md'), 'USER-GLOBAL\n');
    await writeFile(join(repo.path, 'CLAUDE.md'), 'PROJECT-ROOT\n');
    await mkdir(join(repo.path, 'packages', 'core'), { recursive: true });
    await writeFile(join(repo.path, 'packages', 'core', 'CLAUDE.md'), 'NESTED-CORE\n');

    const cfg = await new AgentConfigDetector(repo.path).detect({ userConfigDir: user.path });
    assert.ok(cfg);
    // flavor/path describe the PROJECT pick, unchanged.
    assert.equal(cfg.flavor, 'claude');
    assert.equal(cfg.path, join(repo.path, 'CLAUDE.md'));
    // Order: user → project, each block labeled. The nested file is discovered but NOT concatenated
    // (issue #192) — it is delivered when a file under packages/core is first touched.
    assert.equal(
      cfg.contents,
      [
        `Contents of ${join(user.path, 'CLAUDE.md')}:\nUSER-GLOBAL\n`,
        'Contents of CLAUDE.md:\nPROJECT-ROOT\n',
      ].join('\n\n'),
    );
    assert.doesNotMatch(cfg.contents, /NESTED-CORE/, 'nested content is not paid for up front');
    // `sources` still records every layer discovery found, nested included.
    assert.deepEqual(cfg.sources, [
      { path: join(user.path, 'CLAUDE.md'), scope: 'user' },
      { path: join(repo.path, 'CLAUDE.md'), scope: 'project' },
      { path: join(repo.path, 'packages', 'core', 'CLAUDE.md'), scope: 'nested' },
    ]);
    assert.deepEqual(cfg.nested, [
      {
        dir: join(repo.path, 'packages', 'core'),
        path: join(repo.path, 'packages', 'core', 'CLAUDE.md'),
        contents: 'NESTED-CORE\n',
      },
    ]);
  } finally {
    await repo.cleanup();
    await user.cleanup();
  }
});

test('detect: root-only (no user, no nested) → contents byte-identical, single project source', async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.path, 'CLAUDE.md'), '# just the root\nstyle\n');
    const cfg = await new AgentConfigDetector(repo.path).detect({});
    assert.ok(cfg);
    assert.equal(cfg.contents, '# just the root\nstyle\n', 'no label — byte-identical to today');
    assert.deepEqual(cfg.sources, [{ path: join(repo.path, 'CLAUDE.md'), scope: 'project' }]);
  } finally {
    await repo.cleanup();
  }
});

test('detect: user-global present but NO project file → null (CLI error path unchanged)', async () => {
  const repo = await makeTempRepo();
  const user = await tempUserDir();
  try {
    await writeFile(join(user.path, 'CLAUDE.md'), 'USER-GLOBAL\n');
    // No CLAUDE.md/AGENTS.md at the repo root, no nested.
    const cfg = await new AgentConfigDetector(repo.path).detect({ userConfigDir: user.path });
    assert.equal(cfg, null, 'user-global is additive only — the project layer gates detection');
  } finally {
    await repo.cleanup();
    await user.cleanup();
  }
});

test('discoverNested: skips .git/node_modules/hidden/.ai-task-master; deterministic depth-then-path', async () => {
  const repo = await makeTempRepo();
  try {
    await writeFile(join(repo.path, 'CLAUDE.md'), 'ROOT\n');
    // Nested files that MUST be found, at varying depth.
    await mkdir(join(repo.path, 'b'), { recursive: true });
    await writeFile(join(repo.path, 'b', 'CLAUDE.md'), 'B\n');
    await mkdir(join(repo.path, 'a', 'deep'), { recursive: true });
    await writeFile(join(repo.path, 'a', 'CLAUDE.md'), 'A\n');
    await writeFile(join(repo.path, 'a', 'deep', 'CLAUDE.md'), 'A-DEEP\n');
    // Skipped locations.
    for (const skip of ['node_modules', '.git', '.ai-task-master', '.hidden']) {
      await mkdir(join(repo.path, skip), { recursive: true });
      await writeFile(join(repo.path, skip, 'CLAUDE.md'), `SKIP-${skip}\n`);
    }
    const cfg = await new AgentConfigDetector(repo.path).detect({});
    assert.ok(cfg);
    const nested = cfg.sources.filter((s) => s.scope === 'nested').map((s) => s.path);
    // depth 1 (a, b sorted by path) then depth 2 (a/deep) — none from skipped dirs.
    assert.deepEqual(nested, [
      join(repo.path, 'a', 'CLAUDE.md'),
      join(repo.path, 'b', 'CLAUDE.md'),
      join(repo.path, 'a', 'deep', 'CLAUDE.md'),
    ]);
    assert.ok(!cfg.contents.includes('SKIP-'), 'no skipped-dir content leaked in');
  } finally {
    await repo.cleanup();
  }
});

test('discoverNested: honors the byte budget, skips the overflow, and warns', async () => {
  const repo = await makeTempRepo();
  const warnings: string[] = [];
  try {
    await writeFile(join(repo.path, 'CLAUDE.md'), 'ROOT\n');
    // First nested file just under budget; second pushes over → skipped + warned.
    await mkdir(join(repo.path, 'a'), { recursive: true });
    await mkdir(join(repo.path, 'z'), { recursive: true });
    await writeFile(join(repo.path, 'a', 'CLAUDE.md'), 'x'.repeat(64 * 1024 - 10));
    await writeFile(join(repo.path, 'z', 'CLAUDE.md'), 'y'.repeat(100));
    const cfg = await new AgentConfigDetector(repo.path).detect({
      onWarn: (m) => warnings.push(m),
    });
    assert.ok(cfg);
    const nested = cfg.sources.filter((s) => s.scope === 'nested').map((s) => s.path);
    assert.deepEqual(nested, [join(repo.path, 'a', 'CLAUDE.md')], 'z skipped past budget');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /budget .* exceeded; skipping z\/CLAUDE\.md/);
  } finally {
    await repo.cleanup();
  }
});

test('detect: user-global @-imports resolve within its own dir, never the repo (issue #117 containment)', async () => {
  const repo = await makeTempRepo();
  const user = await tempUserDir();
  try {
    await writeFile(join(repo.path, 'CLAUDE.md'), 'PROJECT\n');
    await writeFile(join(user.path, 'shared.md'), 'USER-IMPORTED\n');
    await writeFile(join(user.path, 'CLAUDE.md'), 'top\n@shared.md\n');
    const cfg = await new AgentConfigDetector(repo.path).detect({ userConfigDir: user.path });
    assert.ok(cfg);
    // The user-global import expanded from ~/.claude, not repoRoot.
    assert.match(cfg.contents, /USER-IMPORTED/);
  } finally {
    await repo.cleanup();
    await user.cleanup();
  }
});

test('discoverNested: budget counts EXPANDED size — a tiny file with a large @-import fills it (issue #117)', async () => {
  const repo = await makeTempRepo();
  const warnings: string[] = [];
  try {
    await writeFile(join(repo.path, 'CLAUDE.md'), 'ROOT\n');
    // a/CLAUDE.md is tiny raw (`@big.md`) but expands to ~64 KiB, so it alone consumes the budget.
    await mkdir(join(repo.path, 'a'), { recursive: true });
    await mkdir(join(repo.path, 'z'), { recursive: true });
    await writeFile(join(repo.path, 'a', 'big.md'), 'x'.repeat(64 * 1024 - 40));
    await writeFile(join(repo.path, 'a', 'CLAUDE.md'), '@big.md\n');
    await writeFile(join(repo.path, 'z', 'CLAUDE.md'), 'y'.repeat(100));
    const cfg = await new AgentConfigDetector(repo.path).detect({
      onWarn: (m) => warnings.push(m),
    });
    assert.ok(cfg);
    // a's EXPANDED content pushed the budget, so z (100 raw bytes) is skipped — proving the cap is on
    // expanded, not raw (a's raw is ~8 bytes). If it counted raw, z would have fit.
    const nested = cfg.sources.filter((s) => s.scope === 'nested').map((s) => s.path);
    assert.deepEqual(nested, [join(repo.path, 'a', 'CLAUDE.md')]);
    // The expansion is asserted on the held-back layer now, not on `contents` (issue #192).
    assert.match(cfg.nested[0]?.contents ?? '', /x{1000}/, 'the @-import was expanded inline');
    assert.doesNotMatch(cfg.contents, /x{1000}/, 'and it never reaches the up-front digest');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /skipping z\/CLAUDE\.md/);
  } finally {
    await repo.cleanup();
  }
});

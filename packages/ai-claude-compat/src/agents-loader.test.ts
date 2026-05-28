import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeDirs, loadAgents } from './agents-loader.ts';

async function tempDir(
  prefix = 'compat-agents-',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function writeAgent(claudeDir: string, file: string, content: string): Promise<void> {
  await mkdir(join(claudeDir, 'agents'), { recursive: true });
  await writeFile(join(claudeDir, 'agents', file), content);
}

test('loadAgents: parses frontmatter (tools flow array, model) + body as system prompt', async () => {
  const dir = await tempDir();
  try {
    const claude = join(dir.path, '.claude');
    await writeAgent(
      claude,
      'explore.md',
      '---\nname: Explore\ndescription: Find code\ntools: [Read, Bash, Grep]\nmodel: haiku\n---\nYou are a code-exploration agent.\n',
    );
    const [agent] = await loadAgents(claude);
    assert.equal(agent?.name, 'Explore');
    assert.equal(agent?.description, 'Find code');
    assert.deepEqual(agent?.tools, ['Read', 'Bash', 'Grep']);
    assert.equal(agent?.model, 'haiku');
    assert.equal(agent?.systemPrompt, 'You are a code-exploration agent.');
  } finally {
    await dir.cleanup();
  }
});

test('loadAgents: name falls back to file basename; tools/model omitted when absent', async () => {
  const dir = await tempDir();
  try {
    const claude = join(dir.path, '.claude');
    await writeAgent(claude, 'planner.md', '---\ndescription: plans\n---\nbody');
    const [agent] = await loadAgents(claude);
    assert.equal(agent?.name, 'planner');
    assert.equal(agent?.tools, undefined);
    assert.equal(agent?.model, undefined);
  } finally {
    await dir.cleanup();
  }
});

test('loadAgents: ignores non-.md files, sorts by name', async () => {
  const dir = await tempDir();
  try {
    const claude = join(dir.path, '.claude');
    await writeAgent(claude, 'zeta.md', '---\nname: zeta\ndescription: z\n---\nb');
    await writeAgent(claude, 'alpha.md', '---\nname: alpha\ndescription: a\n---\nb');
    await writeAgent(claude, 'notes.txt', 'ignore me');
    const agents = await loadAgents(claude);
    assert.deepEqual(
      agents.map((a) => a.name),
      ['alpha', 'zeta'],
    );
  } finally {
    await dir.cleanup();
  }
});

test('loadAgents: missing agents dir yields []', async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await loadAgents(join(dir.path, '.claude')), []);
  } finally {
    await dir.cleanup();
  }
});

test('claudeDirs: global then project, project last (higher precedence)', () => {
  const dirs = claudeDirs('/repo');
  assert.deepEqual(dirs, [join(homedir(), '.claude'), join('/repo', '.claude')]);
});

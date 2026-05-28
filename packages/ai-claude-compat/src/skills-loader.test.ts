import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSkills } from './skills-loader.ts';

async function tempDir(
  prefix = 'compat-skills-',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

async function writeSkill(claudeDir: string, name: string, content: string): Promise<void> {
  await mkdir(join(claudeDir, 'skills', name), { recursive: true });
  await writeFile(join(claudeDir, 'skills', name, 'SKILL.md'), content);
}

test('loadSkills: parses each SKILL.md, sorted by name', async () => {
  const dir = await tempDir();
  try {
    const claude = join(dir.path, '.claude');
    await writeSkill(
      claude,
      'deploy',
      '---\nname: deploy\ndescription: Ship it\n---\n# Steps\n1. go\n',
    );
    await writeSkill(claude, 'audit', '---\nname: audit\ndescription: Check it\n---\nbody\n');
    const skills = await loadSkills(claude);
    assert.deepEqual(
      skills.map((s) => s.name),
      ['audit', 'deploy'],
    );
    const deploy = skills.find((s) => s.name === 'deploy');
    assert.equal(deploy?.description, 'Ship it');
    assert.equal(deploy?.body, '# Steps\n1. go');
    assert.ok(deploy?.path.endsWith(join('skills', 'deploy', 'SKILL.md')));
  } finally {
    await dir.cleanup();
  }
});

test('loadSkills: name falls back to the directory name', async () => {
  const dir = await tempDir();
  try {
    const claude = join(dir.path, '.claude');
    await writeSkill(claude, 'release', '---\ndescription: no name field\n---\nbody');
    const skills = await loadSkills(claude);
    assert.equal(skills[0]?.name, 'release');
  } finally {
    await dir.cleanup();
  }
});

test('loadSkills: skips folders without a SKILL.md', async () => {
  const dir = await tempDir();
  try {
    const claude = join(dir.path, '.claude');
    await mkdir(join(claude, 'skills', 'empty'), { recursive: true });
    await writeSkill(claude, 'real', '---\nname: real\ndescription: d\n---\nb');
    const skills = await loadSkills(claude);
    assert.deepEqual(
      skills.map((s) => s.name),
      ['real'],
    );
  } finally {
    await dir.cleanup();
  }
});

test('loadSkills: missing skills dir yields []', async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await loadSkills(join(dir.path, '.claude')), []);
  } finally {
    await dir.cleanup();
  }
});

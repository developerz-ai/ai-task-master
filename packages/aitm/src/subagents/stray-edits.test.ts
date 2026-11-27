import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashTool } from '@developerz.ai/ai-claude-compat';
import { execa } from 'execa';
import { DEFAULT_BASH_RULES } from '../config/config-loader.ts';
import { makeTempRepo, type TempRepo } from '../testing/temp-repo.ts';
import { discardStrayEdits, hasStrayEdit } from './stray-edits.ts';

// A real repo with one committed file, so the cleanup is exercised against actual git state.
async function seededRepo(): Promise<TempRepo> {
  const repo = await makeTempRepo();
  await writeFile(join(repo.path, 'a.txt'), 'orig\n');
  await execa('git', ['add', 'a.txt'], { cwd: repo.path });
  await execa('git', ['commit', '-m', 'init'], { cwd: repo.path });
  return repo;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test('hasStrayEdit: state-dir entries never count as a dirty tree', () => {
  // In a repo that does not gitignore `.ai-task-master`, aitm's own untracked state files show up in
  // `git status --porcelain`. Counting them would hard-reset the checkout on every non-committing
  // pass — and `git clean` would delete the run's own plan and scratch.
  assert.equal(hasStrayEdit(''), false);
  assert.equal(hasStrayEdit('?? .ai-task-master/\n'), false);
  assert.equal(
    hasStrayEdit('?? .ai-task-master/state.json\n?? .ai-task-master/scratch/fuzz.ts\n'),
    false,
  );
  assert.equal(hasStrayEdit(' M README.md\n'), true);
  assert.equal(hasStrayEdit('?? .ai-task-master/state.json\n M README.md\n'), true);
});

test('discardStrayEdits: a dirty tree is reset and cleaned, sparing the state dir', async () => {
  const repo = await seededRepo();
  try {
    await writeFile(join(repo.path, 'a.txt'), 'stray\n');
    await writeFile(join(repo.path, 'junk.txt'), 'junk\n');
    await execa('mkdir', ['-p', join(repo.path, '.ai-task-master')]);
    await writeFile(join(repo.path, '.ai-task-master', 'state.json'), '{}\n');
    await discardStrayEdits(repo.path);
    assert.equal(await readFile(join(repo.path, 'a.txt'), 'utf8'), 'orig\n');
    assert.equal(await exists(join(repo.path, 'junk.txt')), false);
    assert.equal(await exists(join(repo.path, '.ai-task-master', 'state.json')), true);
  } finally {
    await repo.cleanup();
  }
});

// Regression: the cleanup ran through the model-facing bash tool, whose DEFAULT_BASH_RULES deny
// `git reset --hard` (exit 126, swallowed) — so the stray edit survived into the next `git add -A`
// commit. The harness's own cleanup must work whatever the model's shell is allowed to do.
test('discardStrayEdits: works even where the model shell denies git reset --hard', async () => {
  const repo = await seededRepo();
  try {
    const modelBash = bashTool({ cwd: repo.path, rules: [...DEFAULT_BASH_RULES] });
    const denied = await modelBash.execute?.(
      { command: 'git reset --hard HEAD', description: 'probe' },
      { toolCallId: 'probe', messages: [], context: undefined },
    );
    assert.ok(denied && !(Symbol.asyncIterator in denied) && denied.exitCode === 126);
    await writeFile(join(repo.path, 'a.txt'), 'stray\n');
    await discardStrayEdits(repo.path);
    assert.equal(await readFile(join(repo.path, 'a.txt'), 'utf8'), 'orig\n');
  } finally {
    await repo.cleanup();
  }
});

test('discardStrayEdits: not a git repo → no-op, never throws', async () => {
  await discardStrayEdits('/nonexistent/aitm-stray-edits');
});

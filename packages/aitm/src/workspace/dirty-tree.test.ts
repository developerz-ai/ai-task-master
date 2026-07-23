import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DirtyWorkingTree, dirtyEntries } from './dirty-tree.ts';

test('dirty-tree: porcelain rows for tracked and untracked work → both reported', () => {
  const entries = dirtyEntries(' M src/a.ts\n?? scratch.txt\nD  src/gone.ts\n');
  assert.deepEqual(entries, [' M src/a.ts', '?? scratch.txt', 'D  src/gone.ts']);
});

test('dirty-tree: clean tree (empty or blank-only porcelain) → no entries', () => {
  assert.deepEqual(dirtyEntries(''), []);
  assert.deepEqual(dirtyEntries('\n\n'), []);
});

test("dirty-tree: aitm's own state dir → not dirt", () => {
  const entries = dirtyEntries('?? .ai-task-master/\n?? .ai-task-master/state.json\n M src/a.ts\n');
  assert.deepEqual(entries, [' M src/a.ts'], 'only the user file counts as dirt');
});

test('dirty-tree: state-dir-only tree → clean, so a run may start', () => {
  assert.deepEqual(dirtyEntries('?? .ai-task-master/\n'), []);
});

test('dirty-tree: DirtyWorkingTree message → names the repo, lists entries, offers every way out', () => {
  const err = new DirtyWorkingTree('/repo', [' M src/a.ts', '?? scratch.txt']);

  assert.equal(err.name, 'DirtyWorkingTree');
  assert.deepEqual(err.entries, [' M src/a.ts', '?? scratch.txt']);
  assert.match(err.message, /Refusing to start: \/repo has uncommitted changes\./);
  assert.match(err.message, /M src\/a\.ts/);
  assert.match(err.message, /\?\? scratch\.txt/);
  assert.match(err.message, /git stash -u/, 'the message must name the non-destructive way out');
  assert.match(err.message, /--allow-dirty/, 'and the opt-out flag');
});

test('dirty-tree: more than ten entries → list truncated with a remainder count', () => {
  const entries = Array.from({ length: 13 }, (_, i) => `?? f${i}.txt`);
  const err = new DirtyWorkingTree('/repo', entries);

  assert.match(err.message, /f9\.txt/);
  assert.doesNotMatch(err.message, /f10\.txt/, 'entries past the cap are not listed');
  assert.match(err.message, /… and 3 more/);
  assert.equal(err.entries.length, 13, 'the full set stays on the error for programmatic use');
});

test('dirty-tree: DirtyWorkingTree is an Error subclass → instanceof survives the throw', () => {
  try {
    throw new DirtyWorkingTree('/repo', [' M a.ts']);
  } catch (err) {
    assert.ok(err instanceof DirtyWorkingTree);
    assert.ok(err instanceof Error);
  }
});

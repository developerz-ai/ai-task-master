import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignEditors, dirOf, groupManifestByDir } from './editor-assignment.ts';
import { MAX_FILES_PER_EDITOR } from './editor-fanout.ts';
import type { FileManifestEntry } from './worker.ts';

const entry = (path: string, editor?: string): FileManifestEntry => ({
  path,
  kind: 'modify',
  purpose: `work on ${path}`,
  ...(editor === undefined ? {} : { editor }),
});

test('dirOf: the parent directory, or "." for a repo-root file', () => {
  assert.equal(dirOf('src/auth/login.ts'), 'src/auth');
  assert.equal(dirOf('README.md'), '.');
});

test('groupManifestByDir: files in the same directory collapse onto one leaf', () => {
  const files: FileManifestEntry[] = [
    { path: 'src/a.ts', kind: 'create', purpose: 'a' },
    { path: 'src/b.ts', kind: 'modify', purpose: 'b' },
  ];
  const groups = groupManifestByDir(files, MAX_FILES_PER_EDITOR);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]?.map((f) => f.path),
    ['src/a.ts', 'src/b.ts'],
  );
});

test('groupManifestByDir: distinct directories fan out to separate leaves, order preserved', () => {
  const files: FileManifestEntry[] = [
    { path: 'src/a.ts', kind: 'create', purpose: 'a' },
    { path: 'lib/b.ts', kind: 'create', purpose: 'b' },
    { path: 'README.md', kind: 'modify', purpose: 'root file' },
  ];
  const groups = groupManifestByDir(files, MAX_FILES_PER_EDITOR);
  assert.deepEqual(
    groups.map((g) => g.map((f) => f.path)),
    [['src/a.ts'], ['lib/b.ts'], ['README.md']],
  );
});

test('groupManifestByDir: a directory over the cap is chunked, manifest order preserved', () => {
  const files: FileManifestEntry[] = ['1', '2', '3', '4', '5'].map((n) => ({
    path: `src/f${n}.ts`,
    kind: 'create',
    purpose: n,
  }));
  const groups = groupManifestByDir(files, 3);
  assert.deepEqual(
    groups.map((g) => g.map((f) => f.path)),
    [
      ['src/f1.ts', 'src/f2.ts', 'src/f3.ts'],
      ['src/f4.ts', 'src/f5.ts'],
    ],
  );
});

test('groupManifestByDir: a single-file manifest yields one single-file group (byte-identical path)', () => {
  const files: FileManifestEntry[] = [{ path: 'src/a.ts', kind: 'create', purpose: 'a' }];
  assert.deepEqual(groupManifestByDir(files, MAX_FILES_PER_EDITOR), [
    [{ path: 'src/a.ts', kind: 'create', purpose: 'a' }],
  ]);
});

test('assignEditors: files sharing a tag land on one leaf, in first-appearance order', () => {
  const files = [
    entry('src/routes/auth.ts', 'auth-flow'),
    entry('src/db/schema.ts', 'persistence'),
    entry('test/auth.test.ts', 'auth-flow'),
  ];
  assert.deepEqual(
    assignEditors(files, MAX_FILES_PER_EDITOR).map((a) => [a.editor, a.files.map((f) => f.path)]),
    [
      ['auth-flow', ['src/routes/auth.ts', 'test/auth.test.ts']],
      ['persistence', ['src/db/schema.ts']],
    ],
    'a route and its test cross directories yet belong to one editor — the tag is what says so',
  );
});

test('assignEditors: a tagged group is honored whole, never chunked at the cap', () => {
  // The cap exists to stop a MECHANICAL rule handing one leaf an incoherent pile. When the
  // Coordinator named the group, the pile is the point — and an editor is not rationed.
  const files = Array.from({ length: MAX_FILES_PER_EDITOR + 4 }, (_, i) =>
    entry(`src/feature/f${i}.ts`, 'one-feature'),
  );
  const assignments = assignEditors(files, MAX_FILES_PER_EDITOR);
  assert.equal(assignments.length, 1, 'one deliberate assignment stays one editor');
  assert.equal(assignments[0]?.files.length, MAX_FILES_PER_EDITOR + 4);
});

test('assignEditors: an untagged manifest falls back to directory grouping', () => {
  const files = [entry('src/a.ts'), entry('src/b.ts'), entry('lib/c.ts')];
  assert.deepEqual(
    assignEditors(files, MAX_FILES_PER_EDITOR).map((a) => [a.editor, a.files.map((f) => f.path)]),
    [
      [undefined, ['src/a.ts', 'src/b.ts']],
      [undefined, ['lib/c.ts']],
    ],
    'no lead input → the same split as before the tag existed',
  );
});

test('assignEditors: a partly tagged manifest keeps both halves, tagged first', () => {
  const files = [entry('src/a.ts'), entry('src/routes/auth.ts', 'auth-flow'), entry('src/b.ts')];
  assert.deepEqual(
    assignEditors(files, MAX_FILES_PER_EDITOR).map((a) => [a.editor, a.files.map((f) => f.path)]),
    [
      ['auth-flow', ['src/routes/auth.ts']],
      [undefined, ['src/a.ts', 'src/b.ts']],
    ],
  );
});

test('assignEditors: a blank tag is treated as untagged, never as a group named ""', () => {
  const files = [entry('src/a.ts', '   '), entry('src/b.ts')];
  const assignments = assignEditors(files, MAX_FILES_PER_EDITOR);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0]?.editor, undefined);
});

test('assignEditors: an empty manifest yields no assignments', () => {
  assert.deepEqual(assignEditors([], MAX_FILES_PER_EDITOR), []);
});

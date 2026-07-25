import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignEditors } from './editor-assignment.ts';
import type { FileManifestEntry } from './worker.ts';

const entry = (path: string, editor?: string): FileManifestEntry => ({
  path,
  kind: 'modify',
  purpose: `work on ${path}`,
  ...(editor === undefined ? {} : { editor }),
});

const shape = (files: readonly FileManifestEntry[]) =>
  assignEditors(files).map((a) => [a.editor, a.files.map((f) => f.path)]);

test('assignEditors: files sharing a tag land on one leaf, in first-appearance order', () => {
  assert.deepEqual(
    shape([
      entry('src/routes/auth.ts', 'auth-flow'),
      entry('src/db/schema.ts', 'persistence'),
      entry('test/auth.test.ts', 'auth-flow'),
    ]),
    [
      ['auth-flow', ['src/routes/auth.ts', 'test/auth.test.ts']],
      ['persistence', ['src/db/schema.ts']],
    ],
    'a route and its test cross directories yet belong to one editor — the tag is what says so',
  );
});

test('assignEditors: a tagged group is honored whole, at any size', () => {
  // No per-leaf cap exists: a cap stops a MECHANICAL rule handing one leaf an incoherent pile, and
  // there is no mechanical rule left. When the Coordinator named the group, the pile is the point.
  const files = Array.from({ length: 12 }, (_, i) => entry(`src/feature/f${i}.ts`, 'one-feature'));
  const assignments = assignEditors(files);
  assert.equal(assignments.length, 1, 'one deliberate assignment stays one editor');
  assert.equal(assignments[0]?.files.length, 12);
});

test('assignEditors: an untagged manifest is ONE editor — no directory fallback', () => {
  // Directory grouping is the design the tag replaced; reviving it when the model omits the field
  // would run the replaced behaviour on the one path nobody exercises deliberately. A Coordinator
  // that did not divide the work has not divided it.
  assert.deepEqual(
    shape([entry('src/a.ts'), entry('src/b.ts'), entry('lib/c.ts'), entry('README.md')]),
    [[undefined, ['src/a.ts', 'src/b.ts', 'lib/c.ts', 'README.md']]],
  );
});

test('assignEditors: a partly tagged manifest keeps the remainder as one owner, tagged first', () => {
  assert.deepEqual(
    shape([entry('src/a.ts'), entry('src/routes/auth.ts', 'auth-flow'), entry('src/b.ts')]),
    [
      ['auth-flow', ['src/routes/auth.ts']],
      [undefined, ['src/a.ts', 'src/b.ts']],
    ],
  );
});

test('assignEditors: a blank tag is untagged, never a group named ""', () => {
  const assignments = assignEditors([entry('src/a.ts', '   '), entry('src/b.ts')]);
  assert.deepEqual(
    assignments.map((a) => a.editor),
    [undefined],
  );
  assert.equal(assignments[0]?.files.length, 2);
});

test('assignEditors: manifest order is preserved, so the fanout stays deterministic', () => {
  const files = [
    entry('z.ts', 'second'),
    entry('a.ts', 'first'),
    entry('m.ts', 'second'),
    entry('b.ts', 'first'),
  ];
  assert.deepEqual(shape(files), [
    ['second', ['z.ts', 'm.ts']],
    ['first', ['a.ts', 'b.ts']],
  ]);
  assert.deepEqual(shape(files), shape(files), 'same input, same split');
});

test('assignEditors: an empty manifest yields no assignments', () => {
  assert.deepEqual(assignEditors([]), []);
});

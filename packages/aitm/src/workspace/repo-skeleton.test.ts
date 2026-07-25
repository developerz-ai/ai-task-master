import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRepoSkeleton,
  renderRepoSkeleton,
  SKELETON_MAX_CHILD_DIRS,
  SKELETON_MAX_ROOT_FILES,
  SKELETON_MAX_TOP_DIRS,
} from './repo-skeleton.ts';

const MONOREPO = [
  'package.json',
  'CLAUDE.md',
  'packages/aitm/src/loop/work-loop.ts',
  'packages/aitm/src/loop/planner-wiring.ts',
  'packages/aitm/src/subagents/planner.ts',
  'packages/aitm/docs/subagents.md',
  'packages/compat/src/pool.ts',
  'docs/plans/notes.md',
];

test('buildRepoSkeleton: separates root files from directories and counts files transitively', () => {
  const skeleton = buildRepoSkeleton(MONOREPO);
  assert.equal(skeleton.totalFiles, MONOREPO.length);
  assert.deepEqual(skeleton.rootFiles, ['CLAUDE.md', 'package.json'], 'root files, sorted');
  assert.deepEqual(
    skeleton.dirs.map((d) => [d.path, d.files]),
    [
      ['packages', 5],
      ['docs', 1],
    ],
    'top-level dirs ranked by file count, each counting its whole subtree',
  );
  const [packages] = skeleton.dirs;
  assert.deepEqual(
    packages?.children.map((d) => [d.path, d.files]),
    [
      ['packages/aitm', 4],
      ['packages/compat', 1],
    ],
  );
  assert.deepEqual(
    packages?.children[0]?.children.map((d) => [d.path, d.files]),
    [
      ['packages/aitm/src', 3],
      ['packages/aitm/docs', 1],
    ],
    'child paths stay repo-relative so a scout can pass them straight to glob',
  );
});

test('buildRepoSkeleton: nesting stops at the depth cap', () => {
  const skeleton = buildRepoSkeleton(['a/b/c/d/e.ts'], 3);
  const depths: number[] = [];
  let level = skeleton.dirs;
  while (level.length > 0) {
    depths.push(level.length);
    level = level[0]?.children ?? [];
  }
  assert.equal(depths.length, 3, 'three levels kept, `a/b/c/d` is not registered');
  assert.equal(buildRepoSkeleton(['a/b/c/d/e.ts'], 1).dirs[0]?.children.length, 0);
});

test('buildRepoSkeleton: equal counts break ties by path, so the map is stable across runs', () => {
  const forward = buildRepoSkeleton(['b/one.ts', 'a/one.ts']);
  const reversed = buildRepoSkeleton(['a/one.ts', 'b/one.ts']);
  assert.deepEqual(
    forward.dirs.map((d) => d.path),
    ['a', 'b'],
  );
  assert.deepEqual(
    forward.dirs.map((d) => d.path),
    reversed.dirs.map((d) => d.path),
  );
});

test('buildRepoSkeleton: blank and empty input yield an empty map', () => {
  const skeleton = buildRepoSkeleton(['', '   ']);
  assert.equal(skeleton.totalFiles, 0);
  assert.deepEqual(skeleton.dirs, []);
  assert.deepEqual(skeleton.rootFiles, []);
});

test('renderRepoSkeleton: one line per top and child dir, leaf dirs inline', () => {
  const rendered = renderRepoSkeleton(buildRepoSkeleton(MONOREPO));
  assert.equal(
    rendered,
    [
      'Repo map — 8 tracked file(s)',
      '  root: CLAUDE.md, package.json',
      '  packages/ (5)',
      '    aitm/ (4): src/ (3), docs/ (1)',
      '    compat/ (1): src/ (1)',
      '  docs/ (1)',
      '    plans/ (1)',
    ].join('\n'),
  );
});

test('renderRepoSkeleton: every truncation is announced, never silent', () => {
  const paths = [
    ...Array.from({ length: SKELETON_MAX_ROOT_FILES + 3 }, (_, i) => `root-${i}.ts`),
    ...Array.from({ length: SKELETON_MAX_TOP_DIRS + 2 }, (_, i) => `dir-${i}/file.ts`),
    ...Array.from({ length: SKELETON_MAX_CHILD_DIRS + 1 }, (_, i) => `big/child-${i}/file.ts`),
  ];
  const rendered = renderRepoSkeleton(buildRepoSkeleton(paths));
  assert.match(rendered, /\(\+3 more\)/, 'dropped root files are counted');
  assert.match(rendered, /^ {4}\+1 more dir\(s\)$/m, 'dropped child dirs are counted');
  assert.match(rendered, /^ {2}\+\d+ more dir\(s\)$/m, 'dropped top-level dirs are counted');
});

test('renderRepoSkeleton: a repo with no tracked files still renders a well-formed header', () => {
  assert.equal(renderRepoSkeleton(buildRepoSkeleton([])), 'Repo map — 0 tracked file(s)');
});

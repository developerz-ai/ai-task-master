import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isIgnored, parseGitignore } from './gitignore.ts';

test('parseGitignore drops blank lines, comments, and (unsupported) negations', () => {
  const rules = parseGitignore('\n# a comment\n  \ndist/\n!keep.log\n*.log\n');
  // dist/ and *.log survive; blank, comment, and !keep.log are dropped.
  assert.equal(rules.length, 2);
});

test('a bare name matches by basename at any depth', () => {
  const rules = parseGitignore('*.log\n');
  assert.equal(isIgnored(rules, 'a.log', false), true);
  assert.equal(isIgnored(rules, 'src/nested/b.log', false), true);
  assert.equal(isIgnored(rules, 'src/b.txt', false), false);
});

test('a trailing slash restricts a rule to directories', () => {
  const rules = parseGitignore('dist/\n');
  assert.equal(isIgnored(rules, 'dist', true), true);
  assert.equal(isIgnored(rules, 'src/dist', true), true, 'matches at any depth');
  assert.equal(isIgnored(rules, 'dist', false), false, 'a file named dist is not ignored');
});

test('a directory rule matches the directory (pruning its subtree in the walk)', () => {
  const rules = parseGitignore('dist/\n');
  // The walk skips descending into an ignored directory, so its subtree never appears. A nested
  // directory queried as a dir is caught too.
  assert.equal(isIgnored(rules, 'dist', true), true);
  assert.equal(isIgnored(rules, 'src/dist', true), true);
  assert.equal(isIgnored(rules, 'dist/sub', true), true);
});

test('a leading slash anchors to the .gitignore directory', () => {
  const rules = parseGitignore('/dist\n');
  assert.equal(isIgnored(rules, 'dist', true), true);
  assert.equal(isIgnored(rules, 'src/dist', true), false, 'anchored — only at the root');
});

test('an internal slash also anchors the pattern', () => {
  const rules = parseGitignore('build/output\n');
  assert.equal(isIgnored(rules, 'build/output', false), true);
  assert.equal(isIgnored(rules, 'src/build/output', false), false);
});

test('* stays within a segment; ? matches one non-slash char', () => {
  assert.equal(isIgnored(parseGitignore('*.log\n'), 'a/b.log', false), true);
  assert.equal(isIgnored(parseGitignore('foo?\n'), 'foo1', false), true);
  assert.equal(isIgnored(parseGitignore('foo?\n'), 'foo/', false), false);
});

test('regex metacharacters in a pattern are treated literally', () => {
  const rules = parseGitignore('a.b\n');
  assert.equal(isIgnored(rules, 'a.b', false), true);
  assert.equal(isIgnored(rules, 'axb', false), false, 'the dot is literal, not any-char');
});

test('no rules → nothing ignored', () => {
  assert.equal(isIgnored([], 'anything', false), false);
});

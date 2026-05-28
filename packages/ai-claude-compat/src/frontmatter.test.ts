import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asString, asStringArray, parseFrontmatter } from './frontmatter.ts';

test('parseFrontmatter: scalar fields + body', () => {
  const { data, body } = parseFrontmatter(
    '---\nname: deploy\ndescription: Ship it\n---\n# Instructions\nrun\n',
  );
  assert.equal(data.name, 'deploy');
  assert.equal(data.description, 'Ship it');
  assert.equal(body, '# Instructions\nrun\n');
});

test('parseFrontmatter: flow array', () => {
  const { data } = parseFrontmatter('---\ntools: [Read, Bash, Grep]\n---\nbody');
  assert.deepEqual(data.tools, ['Read', 'Bash', 'Grep']);
});

test('parseFrontmatter: block sequence', () => {
  const { data } = parseFrontmatter('---\ntools:\n  - Read\n  - Bash\n---\nbody');
  assert.deepEqual(data.tools, ['Read', 'Bash']);
});

test('parseFrontmatter: strips quotes and skips comments', () => {
  const { data } = parseFrontmatter('---\n# a comment\nname: "the name"\ndesc: \'q\'\n---\n');
  assert.equal(data.name, 'the name');
  assert.equal(data.desc, 'q');
});

test('parseFrontmatter: no frontmatter returns whole content as body', () => {
  const { data, body } = parseFrontmatter('# just markdown\n');
  assert.deepEqual(data, {});
  assert.equal(body, '# just markdown\n');
});

test('parseFrontmatter: empty body when none follows the closing fence', () => {
  const { data, body } = parseFrontmatter('---\nname: x\n---');
  assert.equal(data.name, 'x');
  assert.equal(body, '');
});

test('asString: joins arrays, empty for undefined', () => {
  assert.equal(asString('a'), 'a');
  assert.equal(asString(['a', 'b']), 'a, b');
  assert.equal(asString(undefined), '');
});

test('asStringArray: passes arrays, splits scalars, undefined when absent', () => {
  assert.deepEqual(asStringArray(['a', 'b']), ['a', 'b']);
  assert.deepEqual(asStringArray('a, b'), ['a', 'b']);
  assert.equal(asStringArray(undefined), undefined);
  assert.equal(asStringArray(''), undefined);
});

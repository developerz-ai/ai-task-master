import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asRecord, asString, asStringArray, parseFrontmatter } from './frontmatter.ts';

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

test('parseFrontmatter: one level of nested map (issue #118)', () => {
  const { data } = parseFrontmatter(
    '---\nname: flaky-ci\ndescription: retry the e2e job\nmetadata:\n  type: project\n  scope: repo\n---\nbody',
  );
  assert.equal(data.name, 'flaky-ci');
  assert.deepEqual(data.metadata, { type: 'project', scope: 'repo' });
  assert.equal(asRecord(data.metadata)?.type, 'project');
});

test('parseFrontmatter: a bare key with neither map nor sequence stays an empty array', () => {
  const { data } = parseFrontmatter('---\nname: x\nmetadata:\n---\nbody');
  assert.deepEqual(data.metadata, []);
});

test('asRecord: returns nested maps, undefined for scalars/arrays/absent', () => {
  assert.deepEqual(asRecord({ type: 'project' }), { type: 'project' });
  assert.equal(asRecord('scalar'), undefined);
  assert.equal(asRecord(['a', 'b']), undefined);
  assert.equal(asRecord(undefined), undefined);
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

// ---- block scalars (issue #120) ----

test('parseFrontmatter: folded block scalar (>) joins lines with spaces, clip keeps one newline', () => {
  const { data } = parseFrontmatter('---\ndescription: >\n  line one\n  line two\n---\nbody');
  assert.equal(data.description, 'line one line two\n');
});

test('parseFrontmatter: folded strip (>-) drops the trailing newline', () => {
  const { data } = parseFrontmatter('---\ndescription: >-\n  line one\n  line two\n---\nbody');
  assert.equal(data.description, 'line one line two');
});

test('parseFrontmatter: literal block scalar (|) preserves interior newlines', () => {
  const { data } = parseFrontmatter('---\nsteps: |\n  first\n  second\n---\nbody');
  assert.equal(data.steps, 'first\nsecond\n');
});

test('parseFrontmatter: literal strip (|-) keeps interior newlines but strips the trailing one', () => {
  const { data } = parseFrontmatter('---\nsteps: |-\n  a\n  b\n---\nbody');
  assert.equal(data.steps, 'a\nb');
});

test('parseFrontmatter: a folded blank line becomes a paragraph break', () => {
  const { data } = parseFrontmatter('---\ndesc: >-\n  para one\n\n  para two\n---\nb');
  assert.equal(data.desc, 'para one\npara two');
});

test('parseFrontmatter: a block scalar ends at the next top-level key, which still parses', () => {
  const { data } = parseFrontmatter(
    '---\nname: s\ndescription: >-\n  folded value\n  continues\nallowed-tools: [Read]\n---\nbody',
  );
  assert.equal(data.name, 's');
  assert.equal(data.description, 'folded value continues');
  assert.deepEqual(data['allowed-tools'], ['Read']);
});

test('parseFrontmatter: `key: >text` on one line stays a plain scalar, not a block header', () => {
  const { data } = parseFrontmatter('---\narrow: >text here\n---\nb');
  assert.equal(data.arrow, '>text here');
});

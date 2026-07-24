import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asObject,
  getDotted,
  parseValue,
  setDotted,
  splitDottedKey,
  unsetDotted,
} from './dotted-path.ts';
import { FORBIDDEN_KEY_SEGMENTS } from './schema.ts';

test('dotted-path: asObject → passes plain objects through, {} otherwise', () => {
  const o = { a: 1 };
  assert.equal(asObject(o), o);
  assert.deepEqual(asObject([1, 2]), {});
  assert.deepEqual(asObject(null), {});
  assert.deepEqual(asObject(42), {});
  assert.deepEqual(asObject('x'), {});
});

test('dotted-path: parseValue → JSON when it parses, bare string otherwise', () => {
  assert.equal(parseValue('squash'), 'squash');
  assert.equal(parseValue('42'), 42);
  assert.equal(parseValue('true'), true);
  assert.equal(parseValue('null'), null);
  assert.deepEqual(parseValue('{"a":1}'), { a: 1 });
  assert.deepEqual(parseValue('[1,2]'), [1, 2]);
  // Non-strings pass through untouched.
  assert.equal(parseValue(42), 42);
  assert.equal(parseValue(null), null);
});

test('dotted-path: splitDottedKey → splits into non-empty segments', () => {
  assert.deepEqual(splitDottedKey('models.coding', 'config key'), ['models', 'coding']);
  assert.deepEqual(splitDottedKey('maxPrs', 'config key'), ['maxPrs']);
});

test('dotted-path: splitDottedKey → rejects empty and empty-segment keys', () => {
  assert.throws(() => splitDottedKey('', 'config key'), /Invalid config key: ""/);
  assert.throws(() => splitDottedKey('models.', 'config key'), /Invalid config key: "models\."/);
  assert.throws(() => splitDottedKey('.models', 'config key'), /Invalid config key: "\.models"/);
});

test('dotted-path: splitDottedKey → rejects every reserved segment', () => {
  for (const seg of FORBIDDEN_KEY_SEGMENTS) {
    assert.throws(() => splitDottedKey(seg, 'config key'), /reserved segment/);
    assert.throws(() => splitDottedKey(`models.${seg}`, 'config key'), /reserved segment/);
  }
});

test('dotted-path: splitDottedKey → appends the hint and keeps label; no hint = no suffix', () => {
  assert.throws(
    () => splitDottedKey('', 'profile key', 'Allowed keys: baseURL.'),
    /Invalid profile key: ""\. Allowed keys: baseURL\.$/,
  );
  assert.throws(
    () => splitDottedKey('__proto__', 'profile key', 'Allowed keys: baseURL.'),
    /reserved segment\. Allowed keys: baseURL\.$/,
  );
  // Without a hint the reserved message ends right after "reserved segment" (no trailing period).
  assert.throws(
    () => splitDottedKey('__proto__', 'config key'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.endsWith('reserved segment'));
      return true;
    },
  );
});

test('dotted-path: setDotted → writes shallow and nested paths, creating parents', () => {
  const obj: Record<string, unknown> = {};
  setDotted(obj, ['maxPrs'], 3);
  assert.deepEqual(obj, { maxPrs: 3 });

  setDotted(obj, ['models', 'coding'], 'x/y');
  assert.deepEqual(obj, { maxPrs: 3, models: { coding: 'x/y' } });
});

test('dotted-path: setDotted → replaces a non-object parent with a fresh object', () => {
  const obj: Record<string, unknown> = { models: 'scalar' };
  setDotted(obj, ['models', 'coding'], 'x/y');
  assert.deepEqual(obj, { models: { coding: 'x/y' } });
});

test('dotted-path: setDotted → empty parts is a no-op', () => {
  const obj: Record<string, unknown> = { a: 1 };
  setDotted(obj, [], 99);
  assert.deepEqual(obj, { a: 1 });
});

test('dotted-path: getDotted → reads nested values, undefined on any miss', () => {
  const obj = { models: { coding: 'x/y' }, scalar: 5 };
  assert.equal(getDotted(obj, ['models', 'coding']), 'x/y');
  assert.equal(getDotted(obj, ['models', 'missing']), undefined);
  // Traversing through a non-object short-circuits to undefined.
  assert.equal(getDotted(obj, ['scalar', 'deep']), undefined);
  // Empty parts returns the object itself.
  assert.equal(getDotted(obj, []), obj);
});

test('dotted-path: unsetDotted → deletes shallow and nested keys, keeps siblings', () => {
  const obj: Record<string, unknown> = { a: 1, b: 2 };
  unsetDotted(obj, ['a']);
  assert.deepEqual(obj, { b: 2 });

  const nested: Record<string, unknown> = { models: { coding: 'x', smart: 'y' } };
  unsetDotted(nested, ['models', 'coding']);
  assert.deepEqual(nested, { models: { smart: 'y' } });
});

test('dotted-path: unsetDotted → no-op through a non-object parent or empty parts', () => {
  const obj: Record<string, unknown> = { scalar: 5 };
  unsetDotted(obj, ['scalar', 'deep']);
  unsetDotted(obj, []);
  assert.deepEqual(obj, { scalar: 5 });
});

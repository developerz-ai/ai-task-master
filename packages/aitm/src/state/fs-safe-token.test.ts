import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeFsToken } from './fs-safe-token.ts';

test('sanitizeFsToken: replaces disallowed characters with underscores', () => {
  assert.equal(sanitizeFsToken('src/foo bar.ts'), 'src_foo_bar.ts');
});

test('sanitizeFsToken: trims leading/trailing underscores produced by the replacement', () => {
  assert.equal(sanitizeFsToken('/absolute/path'), 'absolute_path');
});

test('sanitizeFsToken: keeps dots, hyphens, and underscores as-is', () => {
  assert.equal(sanitizeFsToken('a.b-c_d'), 'a.b-c_d');
});

test('sanitizeFsToken: falls back to "unnamed" when nothing survives sanitization', () => {
  assert.equal(sanitizeFsToken('///'), 'unnamed');
});

test('sanitizeFsToken: falls back to "unnamed" for an empty string', () => {
  assert.equal(sanitizeFsToken(''), 'unnamed');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskSecret } from './mask-secret.ts';

test('mask-secret: long value keeps 6-char head and 4-char tail', () => {
  assert.equal(maskSecret('sk-or-v1-0123456789abcdef'), 'sk-or-…cdef');
});

test('mask-secret: value of 12 chars or fewer is fully hidden', () => {
  assert.equal(maskSecret('short'), '***');
  assert.equal(maskSecret('123456789012'), '***');
});

test('mask-secret: 13 chars is the first length that shows head+tail', () => {
  assert.equal(maskSecret('1234567890123'), '123456…0123');
});

test('mask-secret: never reveals the middle of a long secret', () => {
  const secret = 'sk-or-v1-DEADBEEFmiddleSECRETpart9999';
  const masked = maskSecret(secret);
  assert.ok(!masked.includes('middleSECRETpart'), 'middle must not leak');
  assert.ok(masked.startsWith('sk-or-'));
  assert.ok(masked.endsWith('9999'));
});

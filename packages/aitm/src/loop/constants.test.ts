import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MAX_CI_FIX_ATTEMPTS } from '../config/defaults.ts';
import { DEFAULT_MAX_ITERATIONS } from './constants.ts';

test('DEFAULT_MAX_ITERATIONS: max 30 loop iterations', () => {
  assert.equal(DEFAULT_MAX_ITERATIONS, 30);
});

test('DEFAULT_MAX_CI_FIX_ATTEMPTS: bounds the CI-fix recovery loop at 3 passes', () => {
  assert.equal(DEFAULT_MAX_CI_FIX_ATTEMPTS, 3);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CI_POLL_INTERVAL,
  CI_POLL_TIMEOUT,
  CI_START_WAIT,
  DEFAULT_MAX_CI_FIX_ATTEMPTS,
  DEFAULT_MAX_ITERATIONS,
  MERGE_STATE_WAIT,
} from './constants.ts';

test('CI_POLL_INTERVAL: 10 second poll cadence', () => {
  assert.equal(CI_POLL_INTERVAL, 10_000);
});

test('CI_START_WAIT: 60 second grace period before initial CI poll', () => {
  assert.equal(CI_START_WAIT, 60_000);
});

test('CI_POLL_TIMEOUT: 120 minute total timeout', () => {
  assert.equal(CI_POLL_TIMEOUT, 7_200_000);
});

test('MERGE_STATE_WAIT: 60 second grace before checking merge state', () => {
  assert.equal(MERGE_STATE_WAIT, 60_000);
});

test('DEFAULT_MAX_ITERATIONS: max 30 loop iterations', () => {
  assert.equal(DEFAULT_MAX_ITERATIONS, 30);
});

test('DEFAULT_MAX_CI_FIX_ATTEMPTS: bounds the CI-fix recovery loop at 3 passes', () => {
  assert.equal(DEFAULT_MAX_CI_FIX_ATTEMPTS, 3);
});

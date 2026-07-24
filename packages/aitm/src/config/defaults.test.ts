import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LLM_STEP_TIMEOUT_MS,
  DEFAULT_MAX_CI_FIX_ATTEMPTS,
  DEFAULT_MCP_DEFER_TOOLS_OVER,
} from './defaults.ts';

test('defaults: DEFAULT_MAX_CI_FIX_ATTEMPTS is 3', () => {
  assert.equal(DEFAULT_MAX_CI_FIX_ATTEMPTS, 3);
});

test('defaults: DEFAULT_MCP_DEFER_TOOLS_OVER is 20', () => {
  assert.equal(DEFAULT_MCP_DEFER_TOOLS_OVER, 20);
});

test('defaults: DEFAULT_LLM_STEP_TIMEOUT_MS is 900_000', () => {
  assert.equal(DEFAULT_LLM_STEP_TIMEOUT_MS, 900_000);
});

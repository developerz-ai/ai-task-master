import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LLM_STEP_TIMEOUT_MS, type SubagentFactory, type SubagentInit } from './factory.ts';

test('SubagentInit / SubagentFactory types are exported (compile-time check)', () => {
  // The body is only here so the import is preserved through ts-strip / bundlers.
  const _t: SubagentInit | undefined = undefined;
  const _f: SubagentFactory<unknown, unknown> | undefined = undefined;
  assert.equal(_t, undefined);
  assert.equal(_f, undefined);
});

test('DEFAULT_LLM_STEP_TIMEOUT_MS is 900_000 and clears the 600s bash ceiling (issue #129)', () => {
  assert.equal(DEFAULT_LLM_STEP_TIMEOUT_MS, 900_000);
  assert.ok(DEFAULT_LLM_STEP_TIMEOUT_MS > 600_000, 'must exceed MAX_BASH_TIMEOUT_MS');
});

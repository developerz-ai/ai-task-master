import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SubagentFactory, SubagentInit } from './factory.ts';

test('SubagentInit / SubagentFactory types are exported (compile-time check)', () => {
  // The body is only here so the import is preserved through ts-strip / bundlers.
  const _t: SubagentInit | undefined = undefined;
  const _f: SubagentFactory<unknown, unknown> | undefined = undefined;
  assert.equal(_t, undefined);
  assert.equal(_f, undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from './args.ts';

test('parseArgs throws until implemented', () => {
  assert.throws(() => parseArgs(['start', 'add jwt auth']));
});

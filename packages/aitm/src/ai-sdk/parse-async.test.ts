import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { hasParseAsync } from './parse-async.ts';

test('hasParseAsync: a zod v4 schema is detected and its parseAsync really parses', async () => {
  const schema = z.object({ path: z.string(), count: z.number().int() });
  assert.equal(hasParseAsync(schema), true, 'a zod schema exposes parseAsync');

  if (!hasParseAsync<{ path: string; count: number }>(schema)) {
    throw new Error('the zod schema was not detected');
  }
  assert.deepEqual(await schema.parseAsync({ path: 'src/index.ts', count: 2 }), {
    path: 'src/index.ts',
    count: 2,
  });
  await assert.rejects(() => schema.parseAsync({ path: 7, count: 2 }), /invalid_type/);
});

test('hasParseAsync: the SDK JSON-schema wrapper is not detected', () => {
  assert.equal(
    hasParseAsync({ type: 'object', properties: { path: { type: 'string' } } }),
    false,
    'a JSON schema has no parseAsync',
  );
});

test('hasParseAsync: a parseAsync that is not a function is not detected', () => {
  assert.equal(hasParseAsync({ parseAsync: 'not a function' }), false);
  assert.equal(hasParseAsync({ parseAsync: undefined }), false);
  assert.equal(hasParseAsync({ parseAsync: {} }), false);
});

test('hasParseAsync: null, undefined, primitives and a plain function are not detected', () => {
  assert.equal(hasParseAsync(null), false);
  assert.equal(hasParseAsync(undefined), false);
  assert.equal(hasParseAsync('schema'), false);
  assert.equal(hasParseAsync(42), false);
  assert.equal(hasParseAsync(true), false);
  assert.equal(
    hasParseAsync(() => undefined),
    false,
  );
});

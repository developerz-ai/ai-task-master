import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { formatZodError, isNotFound, readJsonFile, readJsonObjectFile } from './json-file.ts';

type Temp = { path: string; cleanup: () => Promise<void> };

async function tempDir(): Promise<Temp> {
  const path = await mkdtemp(join(tmpdir(), 'aitm-json-file-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

test('json-file: isNotFound → true only for ENOENT-shaped errors', () => {
  assert.equal(isNotFound({ code: 'ENOENT' }), true);
  assert.equal(isNotFound(Object.assign(new Error('nope'), { code: 'ENOENT' })), true);
  assert.equal(isNotFound({ code: 'EACCES' }), false);
  assert.equal(isNotFound(new Error('plain')), false);
  assert.equal(isNotFound(null), false);
  assert.equal(isNotFound('ENOENT'), false);
});

test('json-file: formatZodError → joins issue paths, <root> for top level', () => {
  const nested = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
  assert.equal(nested.success, false);
  if (!nested.success) assert.match(formatZodError(nested.error), /^a\.b: /);

  const rootLevel = z.string().safeParse(123);
  assert.equal(rootLevel.success, false);
  if (!rootLevel.success) assert.match(formatZodError(rootLevel.error), /^<root>: /);
});

test('json-file: readJsonFile → undefined when the file is absent', async () => {
  const { path, cleanup } = await tempDir();
  try {
    assert.equal(await readJsonFile(join(path, 'missing.json')), undefined);
  } finally {
    await cleanup();
  }
});

test('json-file: readJsonFile → parsed value for object, array, and null', async () => {
  const { path, cleanup } = await tempDir();
  try {
    const obj = join(path, 'obj.json');
    await writeFile(obj, '{"a":1}');
    assert.deepEqual(await readJsonFile(obj), { a: 1 });

    const arr = join(path, 'arr.json');
    await writeFile(arr, '[1,2,3]');
    assert.deepEqual(await readJsonFile(arr), [1, 2, 3]);

    const nul = join(path, 'null.json');
    await writeFile(nul, 'null');
    assert.equal(await readJsonFile(nul), null);
  } finally {
    await cleanup();
  }
});

test('json-file: readJsonFile → throws naming the path on malformed JSON', async () => {
  const { path, cleanup } = await tempDir();
  try {
    const bad = join(path, 'bad.json');
    await writeFile(bad, '{not json');
    await assert.rejects(() => readJsonFile(bad), /bad\.json: invalid JSON —/);
  } finally {
    await cleanup();
  }
});

test('json-file: readJsonObjectFile → empty object when the file is absent', async () => {
  const { path, cleanup } = await tempDir();
  try {
    assert.deepEqual(await readJsonObjectFile(join(path, 'missing.json')), {});
  } finally {
    await cleanup();
  }
});

test('json-file: readJsonObjectFile → returns the parsed top-level object', async () => {
  const { path, cleanup } = await tempDir();
  try {
    const file = join(path, 'config.json');
    await writeFile(file, '{"maxPrs":3}');
    assert.deepEqual(await readJsonObjectFile(file), { maxPrs: 3 });
  } finally {
    await cleanup();
  }
});

test('json-file: readJsonObjectFile → rejects a non-object top level', async () => {
  const { path, cleanup } = await tempDir();
  try {
    for (const content of ['[1,2]', 'null', '42', '"str"']) {
      const file = join(path, 'x.json');
      await writeFile(file, content);
      await assert.rejects(
        () => readJsonObjectFile(file),
        /expected a JSON object at the top level/,
      );
    }
  } finally {
    await cleanup();
  }
});

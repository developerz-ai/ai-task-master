import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigLoader } from './config-loader.ts';

test('ConfigLoader is constructible (skeleton)', () => {
  const loader = new ConfigLoader('/tmp/repo', '/tmp/home', {});
  assert.ok(loader instanceof ConfigLoader);
});

test('ConfigLoader.resolve throws until implemented', async () => {
  const loader = new ConfigLoader('/tmp/repo', '/tmp/home', {});
  await assert.rejects(() => loader.resolve({}));
});

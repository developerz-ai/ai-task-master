import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigWriter } from './config-writer.ts';

test('ConfigWriter is constructible (skeleton)', () => {
  const w = new ConfigWriter('/tmp/repo', '/tmp/home');
  assert.ok(w instanceof ConfigWriter);
});

test('ConfigWriter.set/get/list/unset throw until implemented', async () => {
  const w = new ConfigWriter('/tmp/repo', '/tmp/home');
  await assert.rejects(() => w.set('global', 'models.smart', 'x'));
  await assert.rejects(() => w.get('global', 'models.smart'));
  await assert.rejects(() => w.list('global'));
  await assert.rejects(() => w.unset('global', 'models.smart'));
});

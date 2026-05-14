import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger } from './logger.ts';

test('Logger is constructible (skeleton)', () => {
  const log = new Logger('info', 'run-test-id');
  assert.ok(log instanceof Logger);
});

test('Logger.info throws until implemented', () => {
  const log = new Logger('info', 'run-test-id');
  assert.throws(() => log.info('hello'));
});

test('Logger.redact throws until implemented', () => {
  assert.throws(() => Logger.redact({ apiKey: 'secret' }));
});

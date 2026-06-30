import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dsnFromEnv, initErrorReporter } from './error-reporter.ts';

test('dsnFromEnv: AITM_SENTRY_DSN takes precedence over SENTRY_DSN', () => {
  assert.equal(
    dsnFromEnv({ AITM_SENTRY_DSN: 'https://a@aitm/1', SENTRY_DSN: 'https://b@generic/2' }),
    'https://a@aitm/1',
  );
});

test('dsnFromEnv: falls back to SENTRY_DSN', () => {
  assert.equal(dsnFromEnv({ SENTRY_DSN: 'https://b@generic/2' }), 'https://b@generic/2');
});

test('dsnFromEnv: missing or blank → undefined', () => {
  assert.equal(dsnFromEnv({}), undefined);
  assert.equal(dsnFromEnv({ AITM_SENTRY_DSN: '' }), undefined);
  assert.equal(dsnFromEnv({ AITM_SENTRY_DSN: '   ' }), undefined);
});

test('initErrorReporter: no DSN → safe no-op reporter (never throws, never loads the SDK)', async () => {
  const reporter = await initErrorReporter({});
  // The no-op reporter must tolerate use without a DSN or installed SDK.
  assert.doesNotThrow(() => reporter.captureException(new Error('boom')));
  await assert.doesNotReject(reporter.flush());
});

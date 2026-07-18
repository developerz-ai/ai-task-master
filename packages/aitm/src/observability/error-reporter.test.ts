import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dsnFromEnv, initErrorReporter, scrubEvent } from './error-reporter.ts';

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

test('scrubEvent: redacts secret-shaped substrings in the top-level message', () => {
  const event = scrubEvent({ message: 'request failed: Bearer sk-abcdef1234567890' });
  assert.equal(event.message, 'request failed: Bearer [REDACTED]');
});

test('scrubEvent: redacts secrets embedded in exception values', () => {
  const event = scrubEvent({
    exception: {
      values: [
        { type: 'Error', value: 'auth failed for token ghp_1234567890abcdefghijklmnopqrstuvwxyz' },
      ],
    },
  });
  assert.equal(event.exception?.values?.[0]?.value, 'auth failed for token ghp_[REDACTED]');
});

test('scrubEvent: redacts token-bearing request URLs', () => {
  const event = scrubEvent({
    request: { url: 'https://api.example.com/v1?api_key=abcd1234efgh5678' },
  });
  assert.equal(event.request?.url, 'https://api.example.com/v1?api_key=[REDACTED]');
});

test('scrubEvent: redacts secrets embedded in breadcrumb messages', () => {
  const event = scrubEvent({
    breadcrumbs: [{ message: 'cloning https://user:hunter2@github.com/org/repo.git' }],
  });
  assert.equal(
    event.breadcrumbs?.[0]?.message,
    'cloning https://[REDACTED]github.com/org/repo.git',
  );
});

test('scrubEvent: leaves events with no message/exception/request/breadcrumbs untouched', () => {
  const event = scrubEvent({ level: 'error' });
  assert.deepEqual(event, { level: 'error' });
});

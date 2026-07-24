import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearRegisteredSecrets, registerSecretValues } from '../logger/secret-registry.ts';
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

test('scrubEvent: redacts stack-frame locals by key name and scrubs the rest', () => {
  const event = scrubEvent({
    exception: {
      values: [
        {
          type: 'Error',
          stacktrace: {
            frames: [
              {
                function: 'fetchPlan',
                vars: { apiKey: 'opaque-custom-endpoint-key', header: 'Bearer sk-abc123def456' },
              },
            ],
          },
        },
      ],
    },
  });
  const vars = event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars;
  assert.equal(vars?.apiKey, '[REDACTED]');
  assert.equal(vars?.header, 'Bearer [REDACTED]');
});

test('scrubEvent: scrubs stack-frame paths and source context', () => {
  const event = scrubEvent({
    exception: {
      values: [
        {
          type: 'Error',
          stacktrace: {
            frames: [
              {
                filename: 'https://cdn.example.com/app.js?token=abcd1234efgh5678',
                abs_path: 'https://user:hunter2@cdn.example.com/app.js',
                context_line: 'const auth = "Bearer sk-abcdef1234567890";',
                pre_context: ['fetch("https://api.example.com?api_key=abcd1234efgh5678")'],
              },
            ],
          },
        },
      ],
    },
  });
  const frame = event.exception?.values?.[0]?.stacktrace?.frames?.[0];
  assert.equal(frame?.filename, 'https://cdn.example.com/app.js?token=[REDACTED]');
  assert.equal(frame?.abs_path, 'https://[REDACTED]cdn.example.com/app.js');
  assert.equal(frame?.context_line, 'const auth = "Bearer [REDACTED]";');
  assert.deepEqual(frame?.pre_context, ['fetch("https://api.example.com?api_key=[REDACTED]")']);
});

test('scrubEvent: walks breadcrumb data', () => {
  const event = scrubEvent({
    breadcrumbs: [
      {
        category: 'http',
        data: {
          url: 'https://api.example.com?access_token=abcd1234efgh5678',
          authorization: 'Basic ZGVtbzpkZW1v',
          status: 401,
        },
      },
    ],
  });
  assert.deepEqual(event.breadcrumbs?.[0]?.data, {
    url: 'https://api.example.com?access_token=[REDACTED]',
    authorization: '[REDACTED]',
    status: 401,
  });
});

test('scrubEvent: redacts extra, tags, contexts and user', () => {
  const event = scrubEvent({
    extra: {
      command: 'gh auth login --with-token ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      openrouterApiKey: 'opaque-custom-endpoint-key',
    },
    tags: { deployKey: 'opaque', env: 'prod' },
    contexts: { auth: { token: 'opaque', scheme: 'bearer' } },
    user: { id: 'u1', session_token: 'opaque' },
  });
  assert.equal(event.extra?.command, 'gh auth login --with-token ghp_[REDACTED]');
  assert.equal(event.extra?.openrouterApiKey, '[REDACTED]');
  assert.deepEqual(event.tags, { deployKey: '[REDACTED]', env: 'prod' });
  assert.deepEqual(event.contexts?.auth, { token: '[REDACTED]', scheme: 'bearer' });
  assert.deepEqual(event.user, { id: 'u1', session_token: '[REDACTED]' });
});

test('scrubEvent: scrubs logentry message and params', () => {
  const event = scrubEvent({
    logentry: { message: 'auth failed for %s', params: ['glpat-1234567890abcdefghij'] },
  });
  assert.equal(event.logentry?.message, 'auth failed for %s');
  assert.deepEqual(event.logentry?.params, ['glpat-[REDACTED]']);
});

test('scrubEvent: redacts request headers, cookies, query params and body', () => {
  const event = scrubEvent({
    request: {
      headers: {
        Authorization: 'Bearer sk-abcdef1234567890',
        'x-api-key': 'opaque-custom-endpoint-key',
        'user-agent': 'aitm/1',
      },
      cookies: { csrf_token: 'opaque', theme: 'dark' },
      query_string: { api_key: 'opaque' },
      data: { note: 'Bearer sk-abcdef1234567890' },
    },
  });
  assert.deepEqual(event.request?.headers, {
    Authorization: '[REDACTED]',
    'x-api-key': '[REDACTED]',
    'user-agent': 'aitm/1',
  });
  assert.deepEqual(event.request?.cookies, { csrf_token: '[REDACTED]', theme: 'dark' });
  assert.deepEqual(event.request?.query_string, { api_key: '[REDACTED]' });
  assert.deepEqual(event.request?.data, { note: 'Bearer [REDACTED]' });
});

test('scrubEvent: redacts a registered literal key under innocuous field names', () => {
  // Neither guard would catch this on its own: `note`/`endpoint` are not secret-shaped key names,
  // and a custom endpoint's key matches no vendor pattern. Only the startup-registered literal does.
  const key = 'c58f21be97d40a3e6b12';
  let event: ReturnType<typeof scrubEvent>;
  try {
    registerSecretValues([key]);
    event = scrubEvent({
      message: `401 from https://llm.internal/v1 using ${key}`,
      extra: { note: `retried with ${key}`, endpoint: `https://llm.internal/v1#${key}` },
      breadcrumbs: [{ message: `configured key ${key}` }],
    });
  } finally {
    clearRegisteredSecrets();
  }
  assert.equal(event.message, '401 from https://llm.internal/v1 using [REDACTED]');
  assert.equal(event.extra?.note, 'retried with [REDACTED]');
  assert.equal(event.extra?.endpoint, 'https://llm.internal/v1#[REDACTED]');
  assert.equal(event.breadcrumbs?.[0]?.message, 'configured key [REDACTED]');
});

test('scrubEvent: returns the same event object (Sentry beforeSend contract)', () => {
  const event = { message: 'plain' };
  assert.equal(scrubEvent(event), event);
  assert.equal(event.message, 'plain');
});

test('scrubEvent: a cyclic payload terminates and is still scrubbed', () => {
  const cyclic: Record<string, unknown> = { note: 'Bearer sk-abcdef1234567890' };
  cyclic.self = cyclic;
  const event = scrubEvent({ extra: { cyclic } });
  assert.equal(cyclic.note, 'Bearer [REDACTED]');
  assert.equal(event.extra?.cyclic, cyclic);
});

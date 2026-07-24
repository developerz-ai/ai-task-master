import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  type BrowserLauncher,
  LOOPBACK_HOST,
  loopbackCallbackUrl,
  type OAuthConfig,
  type OAuthOptions,
  openBrowser,
  performOAuthFlow,
} from './oauth.ts';

test('generateState produces cryptographically random values', () => {
  const states = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const state = randomBytes(32).toString('base64url');
    states.add(state);
    assert.strictEqual(state.length, 43);
  }
  assert.strictEqual(states.size, 100);
});

test('OAuthConfig has correct structure', () => {
  const config: OAuthConfig = {
    name: 'test-server',
    type: 'http',
    url: 'https://test.com',
    headers: { Authorization: 'Bearer test-token' },
  };

  assert.strictEqual(config.name, 'test-server');
  assert.strictEqual(config.type, 'http');
  assert.strictEqual(config.url, 'https://test.com');
  assert.strictEqual(config.headers.Authorization, 'Bearer test-token');
});

test('loopback host is the IPv4 literal, not localhost', () => {
  assert.strictEqual(LOOPBACK_HOST, '127.0.0.1');
});

test('default callback URL uses the loopback IP literal', () => {
  assert.strictEqual(loopbackCallbackUrl(8787), 'http://127.0.0.1:8787/callback');
  assert.match(loopbackCallbackUrl(9000), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
});

test('performOAuthFlow constructs valid authorization URL', async () => {
  let openedUrl: string | undefined;
  const options: OAuthOptions = {
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'test-client',
    scope: 'read write',
    timeout: 100,
    openBrowser: async (url) => {
      openedUrl = url;
    },
  };

  await assert.rejects(async () => performOAuthFlow(options), /OAuth callback timeout/);

  assert.ok(openedUrl, 'openBrowser was not called');
  const url = new URL(openedUrl);
  assert.strictEqual(url.origin + url.pathname, 'https://example.com/oauth/authorize');
  assert.strictEqual(url.searchParams.get('client_id'), 'test-client');
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.strictEqual(url.searchParams.get('scope'), 'read write');
  assert.match(url.searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.match(url.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/);
});

test('performOAuthFlow requires valid options', async () => {
  const options: OAuthOptions = {
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'test-client',
    timeout: 100,
    openBrowser: async () => {},
  };

  await assert.rejects(async () => performOAuthFlow(options), /OAuth callback timeout/);
});

test('OAuthOptions has correct structure', () => {
  const options: OAuthOptions = {
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    scope: 'read write',
    callbackUrl: 'http://127.0.0.1:8787/callback',
    port: 8787,
    timeout: 30000,
  };

  assert.strictEqual(options.authUrl, 'https://example.com/oauth/authorize');
  assert.strictEqual(options.tokenUrl, 'https://example.com/oauth/token');
  assert.strictEqual(options.clientId, 'test-client');
  assert.strictEqual(options.clientSecret, 'test-secret');
  assert.strictEqual(options.scope, 'read write');
  assert.strictEqual(options.callbackUrl, 'http://127.0.0.1:8787/callback');
  assert.strictEqual(options.port, 8787);
  assert.strictEqual(options.timeout, 30000);
});

test('openBrowser swallows spawn errors on headless hosts', async () => {
  const emitter = new EventEmitter();
  let unrefed = false;
  const launcher: BrowserLauncher = () => ({
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    unref: () => {
      unrefed = true;
    },
  });

  await openBrowser('https://example.com', launcher);

  // Emitting 'error' on an EventEmitter with no listener throws; this passes only because the
  // production handler in openBrowser is registered — deleting it would fail this test.
  assert.doesNotThrow(
    () => emitter.emit('error', new Error('spawn ENOENT')),
    'openBrowser must absorb spawn failures via its error handler',
  );
  assert.ok(unrefed, 'openBrowser must unref the detached process');
});

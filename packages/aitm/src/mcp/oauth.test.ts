import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  LOOPBACK_HOST,
  loopbackCallbackUrl,
  type OAuthConfig,
  type OAuthOptions,
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
  const options: OAuthOptions = {
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'test-client',
    timeout: 100,
  };

  await assert.rejects(async () => performOAuthFlow(options), /OAuth callback timeout/);
});

test('performOAuthFlow requires valid options', async () => {
  const options: OAuthOptions = {
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'test-client',
    timeout: 100,
  };

  assert.rejects(async () => performOAuthFlow(options), /OAuth callback timeout/);
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

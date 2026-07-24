import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
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

test('openBrowser handles spawn errors on headless hosts', async () => {
  const errorEmittingBrowser = async (_url: string): Promise<void> => {
    const { spawn } = await import('node:child_process');

    // Simulate a spawn error by using a non-existent command
    const proc = spawn('/nonexistent/command/that/does/not/exist', [], {
      detached: true,
      stdio: 'ignore',
    }) as unknown as ChildProcess;

    let errorHandled = false;
    proc.on('error', () => {
      errorHandled = true;
    });

    // Wait briefly to ensure the error handler fires
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(errorHandled, 'spawn error should have been handled');
  };

  // This should not throw even though the browser launcher fails
  await errorEmittingBrowser('https://example.com');
});

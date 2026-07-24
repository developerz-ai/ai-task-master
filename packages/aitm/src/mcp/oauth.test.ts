import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  type BrowserLauncher,
  discoverOAuthEndpoints,
  LOOPBACK_HOST,
  loginToMcpServer,
  loopbackCallbackUrl,
  type OAuthConfig,
  type OAuthOptions,
  openBrowser,
  parseCallback,
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
    serverUrl: 'https://example.com/mcp',
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
  assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
});

test('performOAuthFlow requires valid options', async () => {
  const options: OAuthOptions = {
    serverUrl: 'https://example.com/mcp',
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'test-client',
    timeout: 100,
    openBrowser: async () => {},
  };

  await assert.rejects(async () => performOAuthFlow(options), /OAuth callback timeout/);
});

test('performOAuthFlow sends the S256 code_verifier bound to the challenge on token exchange', async () => {
  const tokenUrl = 'https://example.com/oauth/token';
  const realFetch = globalThis.fetch;
  let tokenBody: string | undefined;
  let challenge: string | null = null;

  globalThis.fetch = async (input, init) => {
    if (String(input) === tokenUrl) {
      tokenBody = typeof init?.body === 'string' ? init.body : undefined;
      return new Response(JSON.stringify({ access_token: 'tok-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  };

  try {
    const config = await performOAuthFlow({
      serverUrl: 'https://example.com/mcp',
      authUrl: 'https://example.com/oauth/authorize',
      tokenUrl,
      clientId: 'test-client',
      timeout: 2000,
      openBrowser: async (rawUrl) => {
        const authUrl = new URL(rawUrl);
        challenge = authUrl.searchParams.get('code_challenge');
        const redirectUri = authUrl.searchParams.get('redirect_uri') ?? '';
        const cbState = authUrl.searchParams.get('state') ?? '';
        // Fire the redirect callback once waitForCallback has wired its resolver (next tick).
        setTimeout(() => {
          void realFetch(`${redirectUri}?code=auth-code-1&state=${cbState}`).catch(() => {});
        }, 10);
      },
    });

    assert.strictEqual(config.headers.Authorization, 'Bearer tok-123');
    assert.ok(tokenBody, 'token exchange did not run');
    const body = new URLSearchParams(tokenBody);
    assert.strictEqual(body.get('grant_type'), 'authorization_code');
    assert.strictEqual(body.get('code'), 'auth-code-1');
    const verifier = body.get('code_verifier') ?? '';
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    // PKCE proof-of-possession: challenge must equal BASE64URL(SHA256(verifier)).
    assert.ok(challenge, 'authorization URL carried no code_challenge');
    assert.strictEqual(challenge, createHash('sha256').update(verifier).digest('base64url'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OAuthOptions has correct structure', () => {
  const options: OAuthOptions = {
    serverUrl: 'https://example.com/mcp',
    authUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    scope: 'read write',
    callbackUrl: 'http://127.0.0.1:8787/callback',
    port: 8787,
    timeout: 30000,
  };

  assert.strictEqual(options.serverUrl, 'https://example.com/mcp');
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

test('parseCallback: returns code and state on a success callback', () => {
  assert.deepStrictEqual(parseCallback({ code: 'abc', state: 'xyz' }), {
    code: 'abc',
    state: 'xyz',
  });
});

test('parseCallback: maps error and error_description, keeping state', () => {
  assert.deepStrictEqual(
    parseCallback({ error: 'access_denied', error_description: 'user said no', state: 'xyz' }),
    { error: 'access_denied', errorDescription: 'user said no', state: 'xyz' },
  );
});

test('parseCallback: returns undefined when neither code nor error is present', () => {
  assert.strictEqual(parseCallback({ state: 'xyz' }), undefined);
  assert.strictEqual(parseCallback({}), undefined);
});

test('parseCallback: treats an empty code as missing', () => {
  assert.strictEqual(parseCallback({ code: '', state: 'xyz' }), undefined);
});

test('parseCallback: an error takes precedence over a code', () => {
  const result = parseCallback({ error: 'server_error', code: 'abc', state: 'xyz' });
  assert.ok(result && 'error' in result);
  assert.strictEqual(result.error, 'server_error');
});

// Fire a callback to the loopback server once waitForCallback has wired its resolver (next tick).
function fireCallbackAfter(delayMs: number, url: string): void {
  const realFetch = globalThis.fetch;
  setTimeout(() => {
    void realFetch(url).catch(() => {});
  }, delayMs);
}

test('performOAuthFlow: a state-mismatch callback is reported via onWarn and does not resolve', async () => {
  const warnings: string[] = [];

  await assert.rejects(
    performOAuthFlow({
      serverUrl: 'https://example.com/mcp',
      authUrl: 'https://example.com/oauth/authorize',
      tokenUrl: 'https://example.com/oauth/token',
      clientId: 'test-client',
      timeout: 250,
      onWarn: (message) => warnings.push(message),
      openBrowser: async (rawUrl) => {
        const redirectUri = new URL(rawUrl).searchParams.get('redirect_uri') ?? '';
        fireCallbackAfter(10, `${redirectUri}?code=attacker-code&state=wrong-state`);
      },
    }),
    /OAuth callback timeout/,
  );

  assert.ok(
    warnings.some((w) => w.includes('state parameter mismatch')),
    'a state mismatch must be surfaced via onWarn, not silently swallowed',
  );
});

test('performOAuthFlow: a callback missing both code and error is reported and does not resolve', async () => {
  const warnings: string[] = [];

  await assert.rejects(
    performOAuthFlow({
      serverUrl: 'https://example.com/mcp',
      authUrl: 'https://example.com/oauth/authorize',
      tokenUrl: 'https://example.com/oauth/token',
      clientId: 'test-client',
      timeout: 250,
      onWarn: (message) => warnings.push(message),
      openBrowser: async (rawUrl) => {
        const authUrl = new URL(rawUrl);
        const redirectUri = authUrl.searchParams.get('redirect_uri') ?? '';
        const cbState = authUrl.searchParams.get('state') ?? '';
        // Correct state, but neither code nor error → malformed; must not post code=undefined.
        fireCallbackAfter(10, `${redirectUri}?state=${cbState}`);
      },
    }),
    /OAuth callback timeout/,
  );

  assert.ok(
    warnings.some((w) => w.includes('neither authorization code nor error')),
    'a malformed callback must be surfaced via onWarn',
  );
});

test('performOAuthFlow: the authorized callback still resolves after a state-mismatch probe', async () => {
  const tokenUrl = 'https://example.com/oauth/token';
  const realFetch = globalThis.fetch;
  const warnings: string[] = [];

  globalThis.fetch = async (input, init) => {
    if (String(input) === tokenUrl) {
      return new Response(JSON.stringify({ access_token: 'tok-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  };

  try {
    const config = await performOAuthFlow({
      serverUrl: 'https://example.com/mcp',
      authUrl: 'https://example.com/oauth/authorize',
      tokenUrl,
      clientId: 'test-client',
      timeout: 2000,
      onWarn: (message) => warnings.push(message),
      openBrowser: async (rawUrl) => {
        const authUrl = new URL(rawUrl);
        const redirectUri = authUrl.searchParams.get('redirect_uri') ?? '';
        const cbState = authUrl.searchParams.get('state') ?? '';
        setTimeout(() => {
          // Forged probe first (wrong state), then the authorized callback.
          void realFetch(`${redirectUri}?code=attacker&state=nope`).catch(() => {});
        }, 10);
        setTimeout(() => {
          void realFetch(`${redirectUri}?code=good-code&state=${cbState}`).catch(() => {});
        }, 60);
      },
    });

    assert.strictEqual(config.headers.Authorization, 'Bearer tok-abc');
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(
    warnings.some((w) => w.includes('state parameter mismatch')),
    'the probe should have been reported even though the flow ultimately succeeded',
  );
});

// Drive performOAuthFlow to token exchange with a valid callback, stubbing the token endpoint.
async function runFlowWithTokenResponse(tokenResponse: Response): Promise<OAuthConfig> {
  const tokenUrl = 'https://example.com/oauth/token';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    String(input) === tokenUrl ? tokenResponse : realFetch(input, init);

  try {
    return await performOAuthFlow({
      // serverUrl path deliberately differs from authUrl's, to prove config.url is the server URL
      // verbatim rather than reverse-engineered by stripping /oauth/authorize off authUrl.
      serverUrl: 'https://mcp.example.com/mcp',
      authUrl: 'https://example.com/oauth/authorize',
      tokenUrl,
      clientId: 'test-client',
      timeout: 2000,
      openBrowser: async (rawUrl) => {
        const authUrl = new URL(rawUrl);
        const redirectUri = authUrl.searchParams.get('redirect_uri') ?? '';
        const cbState = authUrl.searchParams.get('state') ?? '';
        setTimeout(() => {
          void realFetch(`${redirectUri}?code=good-code&state=${cbState}`).catch(() => {});
        }, 10);
      },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('performOAuthFlow: config url is the server URL verbatim, not derived from authUrl', async () => {
  const config = await runFlowWithTokenResponse(
    new Response(JSON.stringify({ access_token: 'tok-url' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  assert.strictEqual(config.url, 'https://mcp.example.com/mcp');
  assert.strictEqual(config.name, 'mcp-example-com');
  assert.strictEqual(config.headers.Authorization, 'Bearer tok-url');
});

test('performOAuthFlow: rejects a 200 token response with no access_token', async () => {
  await assert.rejects(
    runFlowWithTokenResponse(
      new Response(JSON.stringify({ token_type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
    /access_token/,
  );
});

test('performOAuthFlow: rejects a 200 token response with an empty access_token', async () => {
  await assert.rejects(
    runFlowWithTokenResponse(
      new Response(JSON.stringify({ access_token: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
    /access_token/,
  );
});

// Bind a throwaway loopback listener to learn a currently-free port, then release it.
async function getFreePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

test('performOAuthFlow: binds the loopback server to the port named by callbackUrl', async () => {
  const port = await getFreePort();
  const callbackUrl = `http://${LOOPBACK_HOST}:${port}/callback`;
  const tokenUrl = 'https://example.com/oauth/token';
  const realFetch = globalThis.fetch;
  let redirectUsed: string | undefined;

  globalThis.fetch = async (input, init) =>
    String(input) === tokenUrl
      ? new Response(JSON.stringify({ access_token: 'tok-port' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : realFetch(input, init);

  try {
    // The callback fetch only reaches a server bound to `port`; with the old auto-scanned bind it
    // would hit a closed port and the flow would time out instead.
    const config = await performOAuthFlow({
      serverUrl: 'https://example.com/mcp',
      authUrl: 'https://example.com/oauth/authorize',
      tokenUrl,
      clientId: 'test-client',
      callbackUrl,
      timeout: 2000,
      openBrowser: async (rawUrl) => {
        const authUrl = new URL(rawUrl);
        redirectUsed = authUrl.searchParams.get('redirect_uri') ?? undefined;
        const cbState = authUrl.searchParams.get('state') ?? '';
        setTimeout(() => {
          void realFetch(`${redirectUsed}?code=good&state=${cbState}`).catch(() => {});
        }, 10);
      },
    });

    assert.strictEqual(redirectUsed, callbackUrl);
    assert.strictEqual(config.headers.Authorization, 'Bearer tok-port');
  } finally {
    globalThis.fetch = realFetch;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('discoverOAuthEndpoints: resolves RFC 8414 authorization-server metadata', async () => {
  const seen: string[] = [];
  const fetchStub: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
      return jsonResponse({
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      });
    }
    return new Response('not found', { status: 404 });
  };

  const endpoints = await discoverOAuthEndpoints('https://mcp.example.com/mcp', {
    fetch: fetchStub,
  });

  assert.strictEqual(endpoints.authorizationEndpoint, 'https://auth.example.com/authorize');
  assert.strictEqual(endpoints.tokenEndpoint, 'https://auth.example.com/token');
});

test('discoverOAuthEndpoints: follows the WWW-Authenticate probe to the authorization server', async () => {
  const fetchStub: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://mcp.example.com/mcp') {
      return new Response('unauthorized', {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
        },
      });
    }
    if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
      return jsonResponse({ authorization_servers: ['https://issuer.example.com'] });
    }
    if (url === 'https://issuer.example.com/.well-known/oauth-authorization-server') {
      return jsonResponse({
        authorization_endpoint: 'https://issuer.example.com/authorize',
        token_endpoint: 'https://issuer.example.com/token',
      });
    }
    return new Response('not found', { status: 404 });
  };

  const endpoints = await discoverOAuthEndpoints('https://mcp.example.com/mcp', {
    fetch: fetchStub,
  });

  assert.strictEqual(endpoints.authorizationEndpoint, 'https://issuer.example.com/authorize');
  assert.strictEqual(endpoints.tokenEndpoint, 'https://issuer.example.com/token');
});

test('discoverOAuthEndpoints: builds a path-aware well-known URL for an issuer with a path', async () => {
  const seen: string[] = [];
  const fetchStub: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url === 'https://mcp.example.com/mcp') {
      return new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/prm"' },
      });
    }
    if (url === 'https://mcp.example.com/prm') {
      return jsonResponse({ authorization_servers: ['https://issuer.example.com/tenant1'] });
    }
    if (url === 'https://issuer.example.com/.well-known/oauth-authorization-server/tenant1') {
      return jsonResponse({
        authorization_endpoint: 'https://issuer.example.com/tenant1/authorize',
        token_endpoint: 'https://issuer.example.com/tenant1/token',
      });
    }
    return new Response('not found', { status: 404 });
  };

  const endpoints = await discoverOAuthEndpoints('https://mcp.example.com/mcp', {
    fetch: fetchStub,
  });

  assert.strictEqual(
    endpoints.authorizationEndpoint,
    'https://issuer.example.com/tenant1/authorize',
  );
  assert.ok(
    seen.includes('https://issuer.example.com/.well-known/oauth-authorization-server/tenant1'),
    'RFC 8414 inserts the well-known segment between host and issuer path',
  );
});

test('discoverOAuthEndpoints: falls back to conventional endpoints and warns when discovery fails', async () => {
  const warnings: string[] = [];
  const fetchStub: typeof fetch = async () => new Response('not found', { status: 404 });

  const endpoints = await discoverOAuthEndpoints('https://dev.local:3000/mcp', {
    fetch: fetchStub,
    onWarn: (message) => warnings.push(message),
  });

  assert.strictEqual(endpoints.authorizationEndpoint, 'https://dev.local:3000/oauth/authorize');
  assert.strictEqual(endpoints.tokenEndpoint, 'https://dev.local:3000/oauth/token');
  assert.ok(warnings.some((w) => w.includes('discovery failed')));
});

test('discoverOAuthEndpoints: falls back when the metadata fetch throws', async () => {
  const fetchStub: typeof fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  const endpoints = await discoverOAuthEndpoints('https://mcp.example.com', {
    fetch: fetchStub,
    onWarn: () => {},
  });

  assert.strictEqual(endpoints.authorizationEndpoint, 'https://mcp.example.com/oauth/authorize');
  assert.strictEqual(endpoints.tokenEndpoint, 'https://mcp.example.com/oauth/token');
});

test('discoverOAuthEndpoints: ignores metadata whose endpoints are not absolute http(s) URLs', async () => {
  const warnings: string[] = [];
  const fetchStub: typeof fetch = async (input) => {
    if (String(input) === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
      return jsonResponse({
        authorization_endpoint: '/authorize',
        token_endpoint: 'ftp://x/token',
      });
    }
    return new Response('not found', { status: 404 });
  };

  const endpoints = await discoverOAuthEndpoints('https://mcp.example.com', {
    fetch: fetchStub,
    onWarn: (message) => warnings.push(message),
  });

  assert.strictEqual(endpoints.authorizationEndpoint, 'https://mcp.example.com/oauth/authorize');
  assert.ok(warnings.some((w) => w.includes('discovery failed')));
});

test('loginToMcpServer: discovers endpoints, then reports the server URL as config url', async () => {
  const realFetch = globalThis.fetch;
  const wellKnown = 'https://mcp.example.com/.well-known/oauth-authorization-server';
  const authorize = 'https://auth.example.com/authorize';
  const tokenEndpoint = 'https://auth.example.com/token';
  let tokenHit = false;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://mcp.example.com/mcp') return new Response('', { status: 200 });
    if (url === wellKnown) {
      return jsonResponse({ authorization_endpoint: authorize, token_endpoint: tokenEndpoint });
    }
    if (url === tokenEndpoint) {
      tokenHit = true;
      return jsonResponse({ access_token: 'tok-login' });
    }
    return realFetch(input, init);
  };

  try {
    const config = await loginToMcpServer({
      serverUrl: 'https://mcp.example.com/mcp',
      timeout: 2000,
      openBrowser: async (rawUrl) => {
        const authUrl = new URL(rawUrl);
        assert.strictEqual(authUrl.origin + authUrl.pathname, authorize);
        const redirectUri = authUrl.searchParams.get('redirect_uri') ?? '';
        const cbState = authUrl.searchParams.get('state') ?? '';
        setTimeout(() => {
          void realFetch(`${redirectUri}?code=c&state=${cbState}`).catch(() => {});
        }, 10);
      },
    });

    assert.strictEqual(config.url, 'https://mcp.example.com/mcp');
    assert.strictEqual(config.name, 'mcp-example-com');
    assert.strictEqual(config.headers.Authorization, 'Bearer tok-login');
    assert.ok(tokenHit, 'token endpoint was not called');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('loginToMcpServer: reads client_id from the server URL query when present', async () => {
  let sentClientId: string | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });

  try {
    await assert.rejects(
      loginToMcpServer({
        serverUrl: 'https://example.com/mcp?client_id=my-registered-app',
        timeout: 120,
        onWarn: () => {},
        openBrowser: async (rawUrl) => {
          sentClientId = new URL(rawUrl).searchParams.get('client_id') ?? undefined;
        },
      }),
      /timeout/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.strictEqual(sentClientId, 'my-registered-app');
});

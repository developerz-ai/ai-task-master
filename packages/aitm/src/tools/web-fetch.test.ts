import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  DEFAULT_STEALTH_HEADERS,
  type LookupFn,
  resolveSafeUrl,
  webFetchTool,
} from './web-fetch.ts';

type FetchCall = { url: string; init: RequestInit };

const originalFetch = globalThis.fetch;

function stubFetch(responder: (call: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;
    calls.push({ url, init });
    return responder({ url, init });
  }) as typeof fetch;
  return { calls };
}

// Default lookup stub: resolve every hostname to a known-public address so tests
// never hit real DNS. Specific tests override this to exercise resolution checks.
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('DEFAULT_STEALTH_HEADERS look like a real browser', () => {
  assert.match(DEFAULT_STEALTH_HEADERS['User-Agent'] ?? '', /Chrome\/\d+/);
  assert.equal(DEFAULT_STEALTH_HEADERS['Sec-Ch-Ua-Mobile'], '?0');
  assert.throws(() => {
    (DEFAULT_STEALTH_HEADERS as Record<string, string>)['User-Agent'] = 'x';
  });
});

test('DEFAULT_STEALTH_HEADERS do not advertise zstd encoding (Node 20 undici cannot decode it)', () => {
  const acceptEncoding = DEFAULT_STEALTH_HEADERS['Accept-Encoding'] ?? '';
  assert.equal(acceptEncoding.includes('zstd'), false);
  assert.ok(acceptEncoding.includes('gzip'));
  assert.ok(acceptEncoding.includes('deflate'));
  assert.ok(acceptEncoding.includes('br'));
});

test('webFetchTool returns a Tool with description and inputSchema', () => {
  const t = webFetchTool();
  assert.ok(t.description);
  assert.ok(t.inputSchema);
});

test('webFetchTool merges DEFAULT_STEALTH_HEADERS with init.headers (override wins)', async () => {
  const { calls } = stubFetch(
    () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
  );
  const t = webFetchTool({
    headers: { 'User-Agent': 'override-ua', 'X-Custom': '1' },
    lookup: publicLookup,
  });
  assert.ok(t.execute);
  await t.execute({ url: 'https://example.com/' });
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers['User-Agent'], 'override-ua');
  assert.equal(headers['X-Custom'], '1');
  assert.equal(headers.Accept, DEFAULT_STEALTH_HEADERS.Accept);
  assert.equal(headers['Sec-Ch-Ua-Mobile'], '?0');
});

test('webFetchTool truncates body to maxChars and flags truncated', async () => {
  const long = 'a'.repeat(500);
  stubFetch(() => new Response(long, { status: 200 }));
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://example.com/', maxChars: 100 });
  assert.equal(result.body.length, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.body, 'a'.repeat(100));
});

test('webFetchTool returns full body when shorter than maxChars', async () => {
  stubFetch(() => new Response('short', { status: 200 }));
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://example.com/' });
  assert.equal(result.body, 'short');
  assert.equal(result.truncated, false);
});

test('webFetchTool tracks finalUrl via Response.url and surfaces status + contentType', async () => {
  stubFetch(
    () =>
      new Response('ok', {
        status: 201,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
  );
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://example.com/start' });
  // Response.url is empty when constructed manually; we fall back to input url.
  assert.equal(result.finalUrl, 'https://example.com/start');
  assert.equal(result.status, 201);
  assert.equal(result.contentType, 'application/json; charset=utf-8');
  assert.equal(result.url, 'https://example.com/start');
  assert.ok(result.retrievedAt);
});

test('webFetchTool passes AbortSignal with timeout through to fetch', async () => {
  const { calls } = stubFetch(() => new Response('x', { status: 200 }));
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  await t.execute({ url: 'https://example.com/', timeoutMs: 250 });
  const signal = calls[0]?.init.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test('webFetchTool propagates an aborted signal as a thrown error', async () => {
  stubFetch(
    ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        // `AbortSignal.timeout()` schedules an unref'd timer. If the listener below is
        // the only pending work, Node's test runner sees the event loop empty out and
        // reports "Promise resolution is still pending but the event loop has already
        // resolved" (cancelledByParent). A ref'd heartbeat keeps the loop alive until
        // the abort fires.
        const heartbeat = setInterval(() => {}, 1);
        signal.addEventListener('abort', () => {
          clearInterval(heartbeat);
          reject(signal.reason ?? new Error('aborted'));
        });
      }),
  );
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  await assert.rejects(() => t.execute({ url: 'https://example.com/', timeoutMs: 10 }));
});

test('webFetchTool sets Referer when referrer input provided', async () => {
  const { calls } = stubFetch(() => new Response('x', { status: 200 }));
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  await t.execute({ url: 'https://example.com/', referrer: 'https://ref.example/' });
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Referer, 'https://ref.example/');
});

test('webFetchTool with init.local=false returns stub redirecting to server tool', async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response('should not be called', { status: 200 });
  });
  const t = webFetchTool({ local: false });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://example.com/' });
  assert.equal(called, false);
  assert.match(result.body, /openrouter:web_fetch/);
  assert.equal(result.status, 0);
  assert.equal(result.finalUrl, 'https://example.com/');
});

test('webFetchTool rejects non-http(s) URLs (SSRF guard)', async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response('x', { status: 200 });
  });
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  await assert.rejects(
    () => t.execute({ url: 'file:///etc/passwd' }),
    /Only http\/https URLs are allowed/,
  );
  assert.equal(called, false);
});

test('webFetchTool rejects loopback and private hosts (SSRF guard)', async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response('x', { status: 200 });
  });
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  for (const url of [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://172.16.0.1/',
    // IPv6 loopback / link-local / unique-local.
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    // IPv4-mapped IPv6 must not bypass the guard (URL normalizes to ::ffff:HEX:HEX).
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:192.168.1.1]/',
  ]) {
    await assert.rejects(() => t.execute({ url }), /private\/loopback/);
  }
  assert.equal(called, false);
});

test('webFetchTool rejects hostname that resolves to a private IP (SSRF guard)', async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response('x', { status: 200 });
  });
  const privateLookup: LookupFn = async () => [{ address: '127.0.0.1' }];
  const t = webFetchTool({ lookup: privateLookup });
  assert.ok(t.execute);
  await assert.rejects(
    () => t.execute({ url: 'https://attacker.example/' }),
    /resolving to private\/loopback/,
  );
  assert.equal(called, false);
});

test('webFetchTool rejects hostname when any resolved IP is private (SSRF guard)', async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response('x', { status: 200 });
  });
  // Mix of public + private — must fail closed on the private one.
  const mixedLookup: LookupFn = async () => [
    { address: '93.184.216.34' },
    { address: '169.254.169.254' },
  ];
  const t = webFetchTool({ lookup: mixedLookup });
  assert.ok(t.execute);
  await assert.rejects(
    () => t.execute({ url: 'https://attacker.example/' }),
    /resolving to private\/loopback/,
  );
  assert.equal(called, false);
});

test('webFetchTool rejects hostname that fails DNS resolution (SSRF guard fails closed)', async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response('x', { status: 200 });
  });
  const failingLookup: LookupFn = async () => {
    throw new Error('ENOTFOUND');
  };
  const t = webFetchTool({ lookup: failingLookup });
  assert.ok(t.execute);
  await assert.rejects(() => t.execute({ url: 'https://nx.example/' }), /DNS lookup failed/);
  assert.equal(called, false);
});

test('webFetchTool does NOT block public domain that happens to start with "fc"', async () => {
  // Regression: prior code applied IPv6 ULA prefix checks (fc/fd/fe8-feb) to all hostnames,
  // which blocked valid public domains like `fc-example.com`. Now gated to IPv6 literals.
  stubFetch(() => new Response('ok', { status: 200 }));
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://fc-example.com/' });
  assert.equal(result.status, 200);
});

test('webFetchTool does NOT block public domain that happens to start with "fe8"', async () => {
  stubFetch(() => new Response('ok', { status: 200 }));
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://feb-public.example/' });
  assert.equal(result.status, 200);
});

test('webFetchTool skips DNS lookup for IP-literal hosts', async () => {
  // IP literals already go through the literal allow/deny in isPrivateOrLoopbackHost,
  // so DNS lookup should not be invoked. Public IP literals must work without DNS access.
  let lookupCalled = false;
  const trackingLookup: LookupFn = async () => {
    lookupCalled = true;
    return [];
  };
  stubFetch(() => new Response('ok', { status: 200 }));
  const t = webFetchTool({ lookup: trackingLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://93.184.216.34/' });
  assert.equal(result.status, 200);
  assert.equal(lookupCalled, false);
});

test('webFetchTool stops reading once maxChars reached', async () => {
  // Build a stream that yields huge chunks. If the implementation buffers everything,
  // the test will OOM-equivalent (or at least slow drastically). Streaming variant
  // should bail at the first chunk past maxChars.
  let chunksPulled = 0;
  const huge = 'x'.repeat(10_000);
  stubFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunksPulled += 1;
            controller.enqueue(new TextEncoder().encode(huge));
            if (chunksPulled > 100) controller.close();
          },
        }),
        { status: 200 },
      ),
  );
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://example.com/', maxChars: 500 });
  assert.equal(result.truncated, true);
  assert.equal(result.body.length, 500);
  // We must have stopped early — not pulled all 100+ chunks.
  assert.ok(chunksPulled < 5, `streamed too long: ${chunksPulled} chunks`);
});

test('webFetchTool follows a safe redirect and returns the final hop, tracking finalUrl', async () => {
  const { calls } = stubFetch(({ url }) =>
    url === 'https://example.com/start'
      ? new Response(null, { status: 302, headers: { location: 'https://example.com/final' } })
      : new Response('final-body', { status: 200, headers: { 'content-type': 'text/plain' } }),
  );
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://example.com/start' });
  assert.equal(result.body, 'final-body');
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, 'https://example.com/final');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.init.redirect, 'manual');
  assert.equal(calls[1]?.init.redirect, 'manual');
});

test('webFetchTool re-validates each redirect hop: blocks a redirect to a private IP literal', async () => {
  const { calls } = stubFetch(({ url }) =>
    url === 'https://example.com/start'
      ? new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        })
      : new Response('SHOULD NOT REACH', { status: 200 }),
  );
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  await assert.rejects(() => t.execute({ url: 'https://example.com/start' }), /private\/loopback/);
  // The redirect target was rejected before it was ever fetched.
  assert.equal(calls.length, 1);
});

test('webFetchTool re-validates redirect hostname via DNS (blocks rebind to a private IP)', async () => {
  const lookup: LookupFn = async (host) =>
    host === 'evil.example' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }];
  const { calls } = stubFetch(({ url }) =>
    url === 'https://good.example/'
      ? new Response(null, { status: 301, headers: { location: 'https://evil.example/' } })
      : new Response('SHOULD NOT REACH', { status: 200 }),
  );
  const t = webFetchTool({ lookup });
  assert.ok(t.execute);
  await assert.rejects(
    () => t.execute({ url: 'https://good.example/' }),
    /resolving to private\/loopback/,
  );
  assert.equal(calls.length, 1);
});

test('webFetchTool resolves a relative redirect Location against the current URL', async () => {
  const { calls } = stubFetch(({ url }) =>
    url === 'https://example.com/a/b'
      ? new Response(null, { status: 302, headers: { location: '/c/d' } })
      : new Response('ok', { status: 200 }),
  );
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://example.com/a/b' });
  assert.equal(result.finalUrl, 'https://example.com/c/d');
  assert.equal(calls[1]?.url, 'https://example.com/c/d');
});

test('webFetchTool rejects a redirect chain that exceeds the hop cap', async () => {
  stubFetch(({ url }) => {
    const n = Number(new URL(url).searchParams.get('n') ?? '0');
    return new Response(null, {
      status: 302,
      headers: { location: `https://example.com/?n=${n + 1}` },
    });
  });
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  await assert.rejects(
    () => t.execute({ url: 'https://example.com/?n=0' }),
    /[Tt]oo many redirects/,
  );
});

test('webFetchTool treats a non-redirect 3xx (304) as the final response', async () => {
  stubFetch(() => new Response(null, { status: 304 }));
  const t = webFetchTool({ lookup: publicLookup });
  assert.ok(t.execute);
  const result = await t.execute({ url: 'https://example.com/' });
  assert.equal(result.status, 304);
});

test('resolveSafeUrl returns the validated addresses for a hostname', async () => {
  const { url, addresses } = await resolveSafeUrl('https://example.com/', async () => [
    { address: '93.184.216.34' },
    { address: '93.184.216.35' },
  ]);
  assert.equal(url.href, 'https://example.com/');
  assert.deepEqual(addresses, ['93.184.216.34', '93.184.216.35']);
});

test('resolveSafeUrl returns no addresses for an IP-literal host (nothing to resolve)', async () => {
  const { addresses } = await resolveSafeUrl('https://93.184.216.34/', async () => {
    throw new Error('lookup should not be called for an IP literal');
  });
  assert.deepEqual(addresses, []);
});

test('resolveSafeUrl rejects a hostname resolving to a private IP', async () => {
  await assert.rejects(
    () => resolveSafeUrl('https://attacker.example/', async () => [{ address: '10.0.0.1' }]),
    /resolving to private\/loopback/,
  );
});

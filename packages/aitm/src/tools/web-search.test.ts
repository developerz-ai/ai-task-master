import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeDdgHref,
  parseDuckDuckGoHtml,
  type WebSearchOutput,
  webSearchTool,
} from './web-search.ts';

// A faithful slice of DuckDuckGo's HTML endpoint: one sponsored result (a `/y.js` anchor with no
// `uddg`), two organic results (redirect hrefs, `&amp;`-escaped, `<b>` term highlighting, HTML
// entities in the snippet), and a duplicate of the first organic URL to exercise dedupe.
const FIXTURE = `
<div class="result result--ad">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=xyz">Sponsored — Buy APIs Now</a>
  <a class="result__snippet" href="//duckduckgo.com/y.js?u3=xyz">Ad copy that must not appear.</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenrouter.ai%2Fdocs%2Fapi&amp;rut=aaa">OpenRouter <b>API</b> Reference</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenrouter.ai%2Fdocs%2Fapi">Comprehensive guide to <b>OpenRouter</b>&#39;s API &amp; auth.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkimi.example%2Fk2&amp;rut=bbb">Kimi K2 model</a>
  <a class="result__snippet">Pricing &amp; limits for k2.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenrouter.ai%2Fdocs%2Fapi&amp;rut=ccc">Duplicate link</a>
  <a class="result__snippet">Should be dropped as a dup.</a>
</div>
`;

test('parseDuckDuckGoHtml: extracts organic results, drops ads and duplicates', () => {
  const results = parseDuckDuckGoHtml(FIXTURE, 10);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: 'OpenRouter API Reference',
    url: 'https://openrouter.ai/docs/api',
    snippet: "Comprehensive guide to OpenRouter's API & auth.",
  });
  assert.deepEqual(results[1], {
    title: 'Kimi K2 model',
    url: 'https://kimi.example/k2',
    snippet: 'Pricing & limits for k2.',
  });
});

test('parseDuckDuckGoHtml: honors maxResults', () => {
  const results = parseDuckDuckGoHtml(FIXTURE, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.url, 'https://openrouter.ai/docs/api');
});

test('parseDuckDuckGoHtml: empty / resultless HTML → []', () => {
  assert.deepEqual(parseDuckDuckGoHtml('<html><body>no results</body></html>', 5), []);
});

test('decodeDdgHref: decodes the uddg redirect target', () => {
  assert.equal(
    decodeDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=z'),
    'https://example.com/a?x=1',
  );
});

test('decodeDdgHref: ad / redirect anchors without uddg → null', () => {
  assert.equal(decodeDdgHref('//duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=xyz'), null);
});

test('decodeDdgHref: a direct external link is accepted', () => {
  assert.equal(decodeDdgHref('https://docs.example.com/page'), 'https://docs.example.com/page');
});

test('parseDuckDuckGoHtml: an escaped entity decodes exactly once (&amp;lt; → literal &lt;, not <)', () => {
  const html = `
  <div class="result results_links results_links_deep web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">Generic vs T&amp;lt;U&amp;gt; and A &amp;amp; B</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">Use &amp;lt;div&amp;gt; tags and cats &amp;amp; dogs.</a>
  </div>`;
  const [result] = parseDuckDuckGoHtml(html, 5);
  assert.ok(result);
  // `&amp;lt;` is one level of escaping over the literal text `<`; decoding must yield `&lt;` (the
  // literal the page meant to show), never the doubly-decoded `<`.
  assert.equal(result.title, 'Generic vs T&lt;U&gt; and A &amp; B');
  assert.equal(result.snippet, 'Use &lt;div&gt; tags and cats &amp; dogs.');
});

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

test('webSearchTool: queries the endpoint and returns parsed results', async () => {
  const calls: string[] = [];
  const tool = webSearchTool({
    endpoint: 'https://search.test/html/',
    fetchImpl: (async (url: unknown) => {
      calls.push(String(url));
      return jsonResponse(FIXTURE);
    }) as typeof fetch,
  });
  const out = (await tool.execute?.(
    { query: 'openrouter api', maxResults: 5 },
    { toolCallId: 't1', messages: [] },
  )) as WebSearchOutput;

  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://search.test/html/?q=openrouter%20api');
  assert.equal(out.error, undefined);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0]?.url, 'https://openrouter.ai/docs/api');
});

test('webSearchTool: a non-200 response yields an error note and no results', async () => {
  const tool = webSearchTool({
    fetchImpl: (async () => jsonResponse('challenge', 202)) as typeof fetch,
  });
  const out = (await tool.execute?.(
    { query: 'x' },
    { toolCallId: 't2', messages: [] },
  )) as WebSearchOutput;
  assert.deepEqual(out.results, []);
  assert.match(out.error ?? '', /HTTP 202/);
});

test('webSearchTool: a network failure is caught and reported, never thrown', async () => {
  const tool = webSearchTool({
    fetchImpl: (async () => {
      throw new Error('boom');
    }) as typeof fetch,
  });
  const out = (await tool.execute?.(
    { query: 'x' },
    { toolCallId: 't3', messages: [] },
  )) as WebSearchOutput;
  assert.deepEqual(out.results, []);
  assert.match(out.error ?? '', /boom/);
});

test('webSearchTool: validates content-type and rejects unexpected types', async () => {
  const tool = webSearchTool({
    fetchImpl: (async () =>
      jsonResponse('not html', 200) as Response & {
        headers: { get: (h: string) => string | null };
      }) as typeof fetch,
  });
  // Mock headers getter to return application/json
  const mockResponse = jsonResponse('{}', 200);
  Object.defineProperty(mockResponse.headers, 'get', {
    value: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
  });
  const tool2 = webSearchTool({
    fetchImpl: (async () => mockResponse) as typeof fetch,
  });
  const out = (await tool2.execute?.(
    { query: 'test' },
    { toolCallId: 't4', messages: [] },
  )) as WebSearchOutput;
  assert.deepEqual(out.results, []);
  assert.match(out.error ?? '', /unexpected content-type/);
});

function fixtureWithContentType(contentType: string | null): typeof fetch {
  return (async () => {
    const response = jsonResponse(FIXTURE, 200);
    Object.defineProperty(response.headers, 'get', {
      value: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null),
    });
    return response;
  }) as typeof fetch;
}

function manyResultsFixture(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const url = encodeURIComponent(`https://example.com/page${i}`);
    return [
      '<div class="result results_links">',
      `  <a class="result__a" href="//duckduckgo.com/l/?uddg=${url}&amp;rut=r${i}">Result ${i}</a>`,
      `  <a class="result__snippet">Snippet ${i}</a>`,
      '</div>',
    ].join('\n');
  }).join('\n');
}

test('webSearchTool: caller-requested maxResults above the ceiling is clamped to RESULTS_CEILING (15)', async () => {
  const tool = webSearchTool({
    endpoint: 'https://search.test/html/',
    fetchImpl: (async () => jsonResponse(manyResultsFixture(20))) as typeof fetch,
  });
  const out = (await tool.execute?.(
    { query: 'test', maxResults: 100 },
    { toolCallId: 't8', messages: [] },
  )) as WebSearchOutput;
  assert.equal(out.error, undefined);
  assert.equal(out.results.length, 15, 'clamped to the 15-result ceiling despite 20 available');
});

test('webSearchTool: accepts text/html and text/plain content types', async () => {
  for (const contentType of ['text/html', 'text/plain'] as const) {
    const tool = webSearchTool({
      endpoint: 'https://search.test/html/',
      fetchImpl: fixtureWithContentType(contentType),
    });
    const out = (await tool.execute?.(
      { query: 'test' },
      { toolCallId: `t5-${contentType}`, messages: [] },
    )) as WebSearchOutput;
    assert.equal(out.error, undefined, `${contentType} should be accepted`);
    assert.ok(out.results.length > 0, `${contentType} should yield results`);
  }
});

test('webSearchTool: normalizes content-type — charset/casing accepted, substring trap rejected', async () => {
  const accepted = webSearchTool({
    endpoint: 'https://search.test/html/',
    fetchImpl: fixtureWithContentType('TEXT/HTML; charset=utf-8'),
  });
  const okOut = (await accepted.execute?.(
    { query: 'test' },
    { toolCallId: 't6', messages: [] },
  )) as WebSearchOutput;
  assert.equal(okOut.error, undefined, 'media type is compared after trim + lowercase');
  assert.ok(okOut.results.length > 0);

  // A value that only *contains* text/html (e.g. `application/json+text/html`) must be rejected —
  // the old substring check accepted it.
  const trap = webSearchTool({
    fetchImpl: fixtureWithContentType('application/json+text/html'),
  });
  const trapOut = (await trap.execute?.(
    { query: 'test' },
    { toolCallId: 't7', messages: [] },
  )) as WebSearchOutput;
  assert.deepEqual(trapOut.results, []);
  assert.match(trapOut.error ?? '', /unexpected content-type/);
});

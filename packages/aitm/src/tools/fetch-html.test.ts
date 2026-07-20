import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ExecLike,
  type FetchHtmlInput,
  fetchHtmlTool,
  isFetchHtmlAvailable,
} from './fetch-html.ts';
import type { LookupFn, WebFetchOutput } from './web-fetch.ts';

// Resolve every hostname to a public IP so the shared SSRF guard doesn't hit real DNS / reject.
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }];

const META = '__AITM_FETCH_HTML_META__';

function metaStderr(status: number, finalUrl: string, contentType: string): string {
  return `\n${META}\t${status}\t${finalUrl}\t${contentType}`;
}

async function run(t: { execute?: unknown }, input: FetchHtmlInput): Promise<WebFetchOutput> {
  const exec = t.execute;
  if (typeof exec !== 'function') throw new Error('tool has no execute');
  return (await (
    exec as (
      i: FetchHtmlInput,
      o: { toolCallId: string; messages: never[] },
    ) => Promise<WebFetchOutput>
  )(input, { toolCallId: 'test', messages: [] })) as WebFetchOutput;
}

test('fetchHtmlTool: parses status/finalUrl/contentType from the metadata, body from stdout', async () => {
  const exec: ExecLike = async () => ({
    stdout: '<html>hi</html>',
    stderr: metaStderr(200, 'https://example.com/final', 'text/html; charset=utf-8'),
  });
  const out = await run(fetchHtmlTool({ exec, lookup: publicLookup }), {
    url: 'https://example.com/',
  });
  assert.equal(out.status, 200);
  assert.equal(out.finalUrl, 'https://example.com/final');
  assert.equal(out.contentType, 'text/html; charset=utf-8');
  assert.equal(out.body, '<html>hi</html>');
  assert.equal(out.truncated, false);
});

test('fetchHtmlTool: maps the impersonate hint to a curl --impersonate target', async () => {
  const calls: string[][] = [];
  const exec: ExecLike = async (_file, args) => {
    calls.push([...args]);
    return { stdout: 'x', stderr: metaStderr(200, 'https://example.com/', 'text/html') };
  };
  await run(fetchHtmlTool({ exec, lookup: publicLookup }), { url: 'https://example.com/' });
  await run(fetchHtmlTool({ exec, lookup: publicLookup }), {
    url: 'https://example.com/',
    impersonate: 'firefox',
  });
  const targetOf = (argv: string[]): string => argv[argv.indexOf('--impersonate') + 1] ?? '';
  assert.equal(targetOf(calls[0] ?? []), 'chrome116');
  assert.equal(targetOf(calls[1] ?? []), 'firefox117');
});

test('fetchHtmlTool: truncates the body to maxChars', async () => {
  const exec: ExecLike = async () => ({
    stdout: 'abcdefghij',
    stderr: metaStderr(200, 'https://example.com/', 'text/html'),
  });
  const out = await run(fetchHtmlTool({ exec, lookup: publicLookup }), {
    url: 'https://example.com/',
    maxChars: 4,
  });
  assert.equal(out.body, 'abcd');
  assert.equal(out.truncated, true);
});

test('fetchHtmlTool: clamps an oversized timeout to the hard max', async () => {
  let captured: string[] = [];
  const exec: ExecLike = async (_file, args) => {
    captured = [...args];
    return { stdout: 'x', stderr: metaStderr(200, 'https://example.com/', 'text/html') };
  };
  await run(fetchHtmlTool({ exec, lookup: publicLookup }), {
    url: 'https://example.com/',
    timeoutMs: 999_999_999,
  });
  // --max-time is in seconds; the 120_000ms ceiling caps it at 120.
  assert.equal(captured[captured.indexOf('--max-time') + 1], '120');
});

test('fetchHtmlTool: pins the validated IP via --resolve and disables redirect following', async () => {
  let captured: string[] = [];
  const exec: ExecLike = async (_file, args) => {
    captured = [...args];
    return { stdout: 'x', stderr: metaStderr(200, 'https://example.com/', 'text/html') };
  };
  await run(fetchHtmlTool({ exec, lookup: publicLookup }), { url: 'https://example.com/' });
  const ri = captured.indexOf('--resolve');
  assert.ok(ri >= 0, 'expected a --resolve pin');
  assert.equal(captured[ri + 1], 'example.com:443:93.184.216.34');
  // Redirects off: no -L / -sSL / --location, and --max-redirs 0 as a belt-and-suspenders guard.
  assert.ok(!captured.some((a) => a === '-L' || a === '-sSL' || a === '--location'));
  assert.equal(captured[captured.indexOf('--max-redirs') + 1], '0');
});

test('fetchHtmlTool: pins on the default port matching the scheme (http → 80)', async () => {
  let captured: string[] = [];
  const exec: ExecLike = async (_file, args) => {
    captured = [...args];
    return { stdout: 'x', stderr: metaStderr(200, 'http://example.com/', 'text/html') };
  };
  await run(fetchHtmlTool({ exec, lookup: publicLookup }), { url: 'http://example.com/' });
  assert.equal(captured[captured.indexOf('--resolve') + 1], 'example.com:80:93.184.216.34');
});

test('fetchHtmlTool: honors an explicit port in the --resolve pin', async () => {
  let captured: string[] = [];
  const exec: ExecLike = async (_file, args) => {
    captured = [...args];
    return { stdout: 'x', stderr: metaStderr(200, 'https://example.com:8443/', 'text/html') };
  };
  await run(fetchHtmlTool({ exec, lookup: publicLookup }), { url: 'https://example.com:8443/' });
  assert.equal(captured[captured.indexOf('--resolve') + 1], 'example.com:8443:93.184.216.34');
});

test('fetchHtmlTool: pins every validated address, bracketing IPv6', async () => {
  let captured: string[] = [];
  const exec: ExecLike = async (_file, args) => {
    captured = [...args];
    return { stdout: 'x', stderr: metaStderr(200, 'https://example.com/', 'text/html') };
  };
  const lookup: LookupFn = async () => [{ address: '93.184.216.34' }, { address: '2606:2800::1' }];
  await run(fetchHtmlTool({ exec, lookup }), { url: 'https://example.com/' });
  assert.equal(
    captured[captured.indexOf('--resolve') + 1],
    'example.com:443:93.184.216.34,[2606:2800::1]',
  );
});

test('fetchHtmlTool: IP-literal host skips --resolve and DNS (host is already the address)', async () => {
  let captured: string[] = [];
  let lookupCalled = false;
  const exec: ExecLike = async (_file, args) => {
    captured = [...args];
    return { stdout: 'x', stderr: metaStderr(200, 'https://93.184.216.34/', 'text/html') };
  };
  const lookup: LookupFn = async () => {
    lookupCalled = true;
    return [];
  };
  await run(fetchHtmlTool({ exec, lookup }), { url: 'https://93.184.216.34/' });
  assert.ok(!captured.includes('--resolve'));
  assert.equal(lookupCalled, false);
});

test('fetchHtmlTool: rejects a private/loopback URL via the shared SSRF guard', async () => {
  const exec: ExecLike = async () => ({ stdout: '', stderr: '' });
  await assert.rejects(
    () => run(fetchHtmlTool({ exec, lookup: publicLookup }), { url: 'http://127.0.0.1/' }),
    /private\/loopback/,
  );
});

test('fetchHtmlTool: missing/failed binary returns a status-0 result, not a throw', async () => {
  const exec: ExecLike = async () => {
    throw new Error('spawn curl-impersonate-chrome ENOENT');
  };
  const out = await run(fetchHtmlTool({ exec, lookup: publicLookup }), {
    url: 'https://example.com/',
  });
  assert.equal(out.status, 0);
  assert.match(out.body, /curl-impersonate/);
});

test('isFetchHtmlAvailable: true when the binary runs, false when it throws', async () => {
  const ok: ExecLike = async () => ({ stdout: 'curl 8.x', stderr: '' });
  const missing: ExecLike = async () => {
    throw new Error('ENOENT');
  };
  assert.equal(await isFetchHtmlAvailable({ exec: ok }), true);
  assert.equal(await isFetchHtmlAvailable({ exec: missing }), false);
});

test('fetchHtmlTool: exposes plain-text toModelOutput (issue #188)', () => {
  assert.equal(typeof fetchHtmlTool().toModelOutput, 'function');
});

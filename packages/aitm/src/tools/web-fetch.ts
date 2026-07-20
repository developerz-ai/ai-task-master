// Local web-fetch tool — default. Runs a stealthed `fetch` from the agent host
// (Chrome-like User-Agent + Sec-Ch-Ua + Accept-* headers), so the model can pull
// public docs without paying for OpenRouter's server-tool round-trip.
//
// For the OpenRouter server-tool variant (model-decides, billable via Exa/Firecrawl/etc.),
// see src/openrouter/server-tools.ts §webFetchServerTool. Pick local for cost / speed,
// server for sites that block scrapers harder than headers fix.
//
// SDK ref: docs/vendor/ai-sdk/chunk-02.md §"Tool Calling" — tool({ description, inputSchema, execute }).

import * as dns from 'node:dns/promises';
import type { Tool } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';

const webFetchInputSchema = z.object({
  url: z.string().url(),
  maxChars: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  referrer: z.string().optional(),
});

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;

export type WebFetchOutput = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  // Truncated to `maxChars`. UTF-8.
  body: string;
  truncated: boolean;
  retrievedAt: string;
};

// Render a fetched page as plain text for the model: a one-line header (final URL, HTTP status,
// content-type, body length, truncation) then the body verbatim — not a JSON-escaped
// {url,body,…} envelope. The escaping tax #127 removed from the fs/bash/search tools was still paid
// here, on the largest single-step payload (issue #188). The typed execute output is unchanged for
// programmatic callers.
export function renderWebFetchOutput(output: WebFetchOutput): string {
  const header = `${output.finalUrl} — HTTP ${output.status}${
    output.contentType ? ` ${output.contentType}` : ''
  } — ${output.body.length} chars${output.truncated ? ' (truncated)' : ''}`;
  return `${header}\n\n${output.body}`;
}

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export type WebFetchInit = {
  // Default true — stealthed local fetch from the agent host. When false, the local
  // function tool is a no-op stub; the model uses OpenRouter's web_fetch server tool
  // configured via providerOptions.openrouter (src/openrouter/server-tools.ts §webFetchServerTool).
  local?: boolean;
  // Override the stealth header set if needed. Default = chrome-on-mac fingerprint.
  headers?: Record<string, string>;
  // DNS lookup used by the SSRF guard. Default = node:dns/promises#lookup with all: true.
  // Injected primarily so tests don't hit real DNS.
  lookup?: LookupFn;
};

export const defaultLookup: LookupFn = async (hostname) => {
  return await dns.lookup(hostname, { all: true });
};

// Validated URL plus every IP its hostname resolved to (empty for IP-literal hosts — the host
// *is* the address). Callers whose transport can pin the connect IP (curl `--resolve`) use
// `addresses` to connect to exactly the IP we checked, closing the DNS-rebind TOCTOU below.
export type SafeUrlResolution = { url: URL; addresses: string[] };

// SSRF guard. Rejects non-http(s), private/loopback/link-local literals, and hostnames
// that resolve to private/loopback IPs, returning the resolved addresses so a pinning-capable
// caller can defeat DNS rebinding. NOT a full fix on its own for `fetch` callers: standard
// fetch re-resolves the hostname at connect time (a hostile resolver could return a public IP
// here and a private one to fetch), and portable connect-time pinning across Bun/Node/Deno
// isn't possible via standard fetch — that needs a runtime-specific dispatcher. curl callers
// close this by pinning `addresses` via `--resolve`.
export async function resolveSafeUrl(rawUrl: string, lookup: LookupFn): Promise<SafeUrlResolution> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Only http/https URLs are allowed: ${u.protocol}`);
  }
  const h = u.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(h)) {
    throw new Error(`Refusing to fetch private/loopback address: ${h}`);
  }
  // IP literals are their own address — nothing to resolve or pin.
  if (isIpLiteral(h)) {
    return { url: u, addresses: [] };
  }
  // For non-literal hostnames, resolve and re-check every returned IP. Closes the
  // "public-looking domain resolves to private IP" bypass on the literal-hostname check.
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(h);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`DNS lookup failed for ${h}: ${message}`);
  }
  if (addrs.length === 0) {
    throw new Error(`Hostname did not resolve to any address: ${h}`);
  }
  for (const { address } of addrs) {
    if (isPrivateOrLoopbackHost(address.toLowerCase())) {
      throw new Error(
        `Refusing to fetch hostname resolving to private/loopback: ${h} → ${address}`,
      );
    }
  }
  return { url: u, addresses: addrs.map((a) => a.address) };
}

// URL-only view of resolveSafeUrl for callers that don't pin the connect IP (standard fetch).
export async function assertSafeUrl(rawUrl: string, lookup: LookupFn): Promise<URL> {
  return (await resolveSafeUrl(rawUrl, lookup)).url;
}

function isIpLiteral(h: string): boolean {
  // Brackets are already stripped by URL.hostname for IPv6, but be defensive.
  const s = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  // IPv6 literals always contain a colon. IPv4 literals are pure dotted quads.
  if (s.includes(':')) return true;
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
}

function isPrivateOrLoopbackHost(h: string): boolean {
  // WHATWG URL preserves brackets on IPv6 hostnames — strip them so the rest can pattern-match.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h === '::1' || h === '::' || h.endsWith('.localhost')) return true;
  // IPv4-mapped IPv6 (::ffff:0:0/96). URL normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1
  // (compressed hex), so handle both dotted and hex tails. Extract embedded IPv4 and re-check.
  if (h.startsWith('::ffff:')) {
    const tail = h.slice(7);
    const dotted = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(tail);
    if (dotted?.[1]) return isPrivateOrLoopbackHost(dotted[1]);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex?.[1] && hex[2]) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isPrivateOrLoopbackHost(ipv4);
    }
    // Unrecognized ::ffff: form — block as a safety net rather than fall through.
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  // IPv6 unique-local fc00::/7, link-local fe80::/10 — only meaningful on IPv6 literals,
  // otherwise we'd block valid public domains like `fc-example.com`.
  if (h.includes(':')) {
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
      return true;
    }
  }
  return false;
}

// Follow redirects manually, re-running the SSRF guard on every hop. Native redirect:'follow'
// would chase a 3xx Location straight past assertSafeUrl (which only saw the initial URL) into a
// private address. Hops are capped like the platform default; `signal` is shared across hops so
// the caller's timeout bounds the whole chain, not each request.
const MAX_REDIRECTS = 20;

async function fetchFollowingSafeRedirects(
  startUrl: URL,
  requestHeaders: Record<string, string>,
  signal: AbortSignal,
  lookup: LookupFn,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = startUrl;
  let redirects = 0;
  while (true) {
    const response = await fetch(currentUrl, {
      headers: requestHeaders,
      redirect: 'manual',
      signal,
    });
    const location = isRedirectStatus(response.status) ? response.headers.get('location') : null;
    if (location === null) {
      return { response, finalUrl: currentUrl.href };
    }
    // Drain the redirect body before the next hop so the socket can be reused/closed.
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (>${MAX_REDIRECTS}) from ${startUrl.href}`);
    }
    redirects += 1;
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error(`Invalid redirect Location from ${currentUrl.href}: ${location}`);
    }
    // Re-validate every hop — this is the SSRF guard that native redirect following skips.
    currentUrl = await assertSafeUrl(nextUrl.href, lookup);
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// Stream the body until `maxChars` UTF-8 characters have been collected, then cancel
// the reader. Avoids buffering an entire huge response into memory just to slice it.
export async function readBodyCapped(
  response: Response,
  maxChars: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        body += decoder.decode();
        break;
      }
      body += decoder.decode(value, { stream: true });
      if (body.length >= maxChars) {
        truncated = body.length > maxChars;
        body = body.slice(0, maxChars);
        await reader.cancel();
        return { body, truncated };
      }
    }
  } finally {
    // Best-effort release; cancel after `done` is a no-op but throws on some streams.
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return { body, truncated };
}

// Default stealth headers — Chrome on macOS. Override via WebFetchInit.headers if a site
// is blocking this exact fingerprint. Keep them in one place so it's easy to bump versions.
export const DEFAULT_STEALTH_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
});

const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const SERVER_TOOL_STUB =
  'Local web-fetch is disabled. Use the openrouter:web_fetch server tool instead (see webFetchServerTool in src/openrouter/server-tools.ts).';

export function webFetchTool(init: WebFetchInit = {}): Tool<WebFetchInput, WebFetchOutput> {
  const local = init.local ?? true;
  const headers: Record<string, string> = { ...DEFAULT_STEALTH_HEADERS, ...init.headers };
  const lookup = init.lookup ?? defaultLookup;

  if (!local) {
    return tool({
      description:
        'Fetch a URL via stealthed local HTTP. Stubbed: this instance delegates to OpenRouter web_fetch server tool.',
      inputSchema: webFetchInputSchema,
      execute: async (input: WebFetchInput): Promise<WebFetchOutput> => ({
        url: input.url,
        finalUrl: input.url,
        status: 0,
        contentType: null,
        body: SERVER_TOOL_STUB,
        truncated: false,
        retrievedAt: new Date().toISOString(),
      }),
      toModelOutput: ({ output }) => ({ type: 'text', value: renderWebFetchOutput(output) }),
    });
  }

  return tool({
    description:
      'Fetch a URL with browser-like headers and return the response body. Body is truncated to maxChars (default 200_000).',
    inputSchema: webFetchInputSchema,
    execute: async (input: WebFetchInput): Promise<WebFetchOutput> => {
      const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const safeUrl = await assertSafeUrl(input.url, lookup);
      const requestHeaders: Record<string, string> = { ...headers };
      if (input.referrer !== undefined) {
        requestHeaders.Referer = input.referrer;
      }
      const { response, finalUrl } = await fetchFollowingSafeRedirects(
        safeUrl,
        requestHeaders,
        AbortSignal.timeout(timeoutMs),
        lookup,
      );
      const { body, truncated } = await readBodyCapped(response, maxChars);
      return {
        url: input.url,
        finalUrl,
        status: response.status,
        contentType: response.headers.get('content-type'),
        body,
        truncated,
        retrievedAt: new Date().toISOString(),
      };
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: renderWebFetchOutput(output) }),
  });
}

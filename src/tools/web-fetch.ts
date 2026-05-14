// Local web-fetch tool — default. Runs a stealthed `fetch` from the agent host
// (Chrome-like User-Agent + Sec-Ch-Ua + Accept-* headers), so the model can pull
// public docs without paying for OpenRouter's server-tool round-trip.
//
// For the OpenRouter server-tool variant (model-decides, billable via Exa/Firecrawl/etc.),
// see src/openrouter/server-tools.ts §webFetchServerTool. Pick local for cost / speed,
// server for sites that block scrapers harder than headers fix.
//
// SDK ref: docs/vendor/ai-sdk/chunk-02.md §"Tool Calling" — tool({ description, inputSchema, execute }).

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

export type WebFetchInit = {
  // Default true — stealthed local fetch from the agent host. When false, the local
  // function tool is a no-op stub; the model uses OpenRouter's web_fetch server tool
  // configured via providerOptions.openrouter (src/openrouter/server-tools.ts §webFetchServerTool).
  local?: boolean;
  // Override the stealth header set if needed. Default = chrome-on-mac fingerprint.
  headers?: Record<string, string>;
};

// Lightweight SSRF guard: reject non-http(s) and obvious private/loopback/link-local hosts
// (no DNS rebinding protection — that requires resolving + revalidation around connect).
// The agent runs arbitrary URLs from a language model; without this, AWS-metadata-style
// internal endpoints become trivially reachable.
function assertSafeUrl(rawUrl: string): URL {
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
  return u;
}

function isPrivateOrLoopbackHost(h: string): boolean {
  if (h === 'localhost' || h === '::1' || h === '::' || h.endsWith('.localhost')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  // IPv6 unique-local fc00::/7, link-local fe80::/10.
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return true;
  }
  return false;
}

// Stream the body until `maxChars` UTF-8 characters have been collected, then cancel
// the reader. Avoids buffering an entire huge response into memory just to slice it.
async function readBodyCapped(
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
        return { body, truncated: true };
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
  'Accept-Encoding': 'gzip, deflate, br, zstd',
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

export function webFetchTool(init: WebFetchInit = {}): Tool {
  const local = init.local ?? true;
  const headers: Record<string, string> = { ...DEFAULT_STEALTH_HEADERS, ...init.headers };

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
    });
  }

  return tool({
    description:
      'Fetch a URL with browser-like headers and return the response body. Body is truncated to maxChars (default 200_000).',
    inputSchema: webFetchInputSchema,
    execute: async (input: WebFetchInput): Promise<WebFetchOutput> => {
      const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const safeUrl = assertSafeUrl(input.url);
      const requestHeaders: Record<string, string> = { ...headers };
      if (input.referrer !== undefined) {
        requestHeaders.Referer = input.referrer;
      }
      const response = await fetch(safeUrl, {
        headers: requestHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const { body, truncated } = await readBodyCapped(response, maxChars);
      return {
        url: input.url,
        finalUrl: response.url || input.url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        body,
        truncated,
        retrievedAt: new Date().toISOString(),
      };
    },
  });
}

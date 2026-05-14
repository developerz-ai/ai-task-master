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
import { type FlexibleSchema, tool } from 'ai';
import { z } from 'zod';

export type WebFetchInput = {
  url: string;
  // Hard cap on returned body size after decode (chars). Default 200_000.
  maxChars?: number;
  // Per-request timeout in ms. Default 15_000.
  timeoutMs?: number;
  // Optional referrer override.
  referrer?: string;
};

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
  const inputSchema = z.object({
    url: z.string().url(),
    maxChars: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    referrer: z.string().optional(),
  }) as unknown as FlexibleSchema<WebFetchInput>;

  if (!local) {
    return tool({
      description:
        'Fetch a URL via stealthed local HTTP. Stubbed: this instance delegates to OpenRouter web_fetch server tool.',
      inputSchema,
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
    inputSchema,
    execute: async (input: WebFetchInput): Promise<WebFetchOutput> => {
      const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const requestHeaders: Record<string, string> = { ...headers };
      if (input.referrer !== undefined) {
        requestHeaders.Referer = input.referrer;
      }
      const response = await fetch(input.url, {
        headers: requestHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const rawBody = await response.text();
      const truncated = rawBody.length > maxChars;
      const body = truncated ? rawBody.slice(0, maxChars) : rawBody;
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

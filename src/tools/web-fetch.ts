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

export function webFetchTool(_init: WebFetchInit = {}): Tool {
  throw new Error('not implemented');
}

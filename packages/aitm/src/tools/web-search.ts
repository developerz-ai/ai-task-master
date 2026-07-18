// Provider-agnostic web search — a client-side function tool so ANY model (Kimi, z.ai, a
// self-hosted endpoint, OpenRouter) can search the web, not just models routed through OpenRouter's
// server-side web_search. aitm's scope is "any provider, any model", and the OpenRouter server tool
// rides `providerOptions.openrouter` — a no-op on a custom `baseURL`. This tool closes that gap.
//
// Backend: DuckDuckGo's no-JS HTML endpoint (no API key). A plain client gets a 202 bot-challenge;
// the browser-like header set from web-fetch.ts (a GET, not POST) returns a 200 with organic
// results. We parse those into {title, url, snippet}. Read a result in full with webFetch/fetchHtml.

import type { Tool } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import { DEFAULT_STEALTH_HEADERS, readBodyCapped } from './web-fetch.ts';

const webSearchInputSchema = z.object({
  query: z.string().min(1),
  // Clamp applied in execute (RESULTS_CEILING); optional so the model can ask for fewer.
  maxResults: z.number().int().positive().optional(),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export type WebSearchResult = { title: string; url: string; snippet: string };
// `error` is set (with empty results) when the search could not run — a non-200 from DuckDuckGo or a
// network/timeout failure. Never thrown: the model reads the note and can retry or fall back.
export type WebSearchOutput = { query: string; results: WebSearchResult[]; error?: string };

export type WebSearchInit = {
  // Test seam — swap the fetch impl so parsing is unit-tested without hitting the network.
  fetchImpl?: typeof fetch;
  // Override the search endpoint (default DuckDuckGo HTML). Mostly for tests.
  endpoint?: string;
  // Override the browser-like header set if DuckDuckGo starts blocking this fingerprint.
  headers?: Record<string, string>;
  timeoutMs?: number;
};

const DEFAULT_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DEFAULT_MAX_RESULTS = 6;
const RESULTS_CEILING = 15;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 1_000_000; // 1MB limit to avoid buffering huge responses

// A small, sufficient HTML-entity decoder for the text DuckDuckGo emits in titles/snippets — named
// entities plus decimal/hex numeric refs. `&amp;` is decoded LAST so an escaped entity like
// `&amp;lt;` decodes once to the literal `&lt;`, not twice to `<` (decoding `&amp;` first would let
// the `&lt;` pass then consume it).
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => codePoint(Number(d)))
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, '&');
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

// Strip tags (DuckDuckGo bolds the matched query terms with <b> inside titles/snippets), decode
// entities, and collapse whitespace to a single-line string.
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// DuckDuckGo wraps every organic result URL in a redirect: `//duckduckgo.com/l/?uddg=<encoded>&rut=…`.
// Return the decoded target URL, or null for non-organic anchors — sponsored results point at
// `//duckduckgo.com/y.js?…` with no `uddg`, so they drop out naturally.
export function decodeDdgHref(href: string): string | null {
  // The href attribute is HTML-escaped (`&amp;`); unescape before parsing query params.
  const unescaped = href.replace(/&amp;/g, '&');
  const abs = unescaped.startsWith('//') ? `https:${unescaped}` : unescaped;
  let u: URL;
  try {
    u = new URL(abs, 'https://duckduckgo.com');
  } catch {
    return null;
  }
  const uddg = u.searchParams.get('uddg');
  if (uddg) return uddg;
  // Occasionally a result is already a direct external link — accept it, but never a bare
  // duckduckgo.com redirect/ad without a target.
  if (
    (u.protocol === 'https:' || u.protocol === 'http:') &&
    !u.hostname.endsWith('duckduckgo.com')
  ) {
    return u.toString();
  }
  return null;
}

// Parse DuckDuckGo's HTML results page into ordered {title, url, snippet}. Each organic result is a
// `result__a` anchor (title + redirect href) followed by a `result__snippet`. A snippet is paired to
// a title only when it falls BETWEEN that title's anchor and the next anchor, so a result missing a
// snippet can't steal the next result's. Ads (no `uddg`) and duplicate URLs are dropped. Exported
// for unit testing against a fixture.
export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[] {
  const anchorRe =
    /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const anchors: Array<{ index: number; href: string; titleHtml: string }> = [];
  for (let m = anchorRe.exec(html); m !== null; m = anchorRe.exec(html)) {
    anchors.push({ index: m.index, href: m[1] ?? '', titleHtml: m[2] ?? '' });
  }
  const snippets: Array<{ index: number; text: string }> = [];
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push({ index: m.index, text: stripTags(m[1] ?? '') });
  }

  const out: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < anchors.length && out.length < maxResults; i++) {
    const a = anchors[i];
    if (a === undefined) continue;
    const url = decodeDdgHref(a.href);
    if (url === null || seen.has(url)) continue;
    const title = stripTags(a.titleHtml);
    if (title === '') continue;
    const nextIndex = anchors[i + 1]?.index ?? Number.POSITIVE_INFINITY;
    const snippet = snippets.find((s) => s.index > a.index && s.index < nextIndex);
    seen.add(url);
    out.push({ title, url, snippet: snippet?.text ?? '' });
  }
  return out;
}

// Accept a `text/html` or `text/plain` response. Parse the media type (the part before `;`), trim,
// and lowercase it so `TEXT/HTML; charset=utf-8` is accepted while a value that merely contains
// `text/html` as a substring is not. A missing header is accepted: some runtimes/proxies omit it on
// an otherwise-valid body (`new Response(str)` sets no content-type under Bun), and the parser
// tolerates non-HTML input by simply returning no results.
function isAcceptableContentType(raw: string | null): boolean {
  if (raw === null) return true;
  const mediaType = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'text/html' || mediaType === 'text/plain';
}

const WEB_SEARCH_DESCRIPTION = [
  'Search the web and return the top results as {title, url, snippet}. Provider-agnostic — works',
  'with any model/provider (backed by DuckDuckGo, no API key). Use it to find current docs, error',
  'messages, API references, or library versions. Then read a promising result in full with',
  '`webFetch` (or `fetchHtml` for scraper-hostile sites). Returns an `error` note with no results',
  'when the search could not run.',
].join(' ');

export function webSearchTool(init: WebSearchInit = {}): Tool<WebSearchInput, WebSearchOutput> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const endpoint = init.endpoint ?? DEFAULT_ENDPOINT;
  const headers: Record<string, string> = { ...DEFAULT_STEALTH_HEADERS, ...init.headers };
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return tool({
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: webSearchInputSchema,
    execute: async (input: WebSearchInput): Promise<WebSearchOutput> => {
      const n = Math.min(input.maxResults ?? DEFAULT_MAX_RESULTS, RESULTS_CEILING);
      const url = `${endpoint}?q=${encodeURIComponent(input.query)}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return {
          query: input.query,
          results: [],
          error: `web search request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // Require exactly 200. DuckDuckGo answers a bot-challenge with 202 (which `Response.ok`
      // counts as success) and an empty body — surface that as an error note, not silent "no
      // results", so the model can retry rather than conclude nothing was found.
      if (response.status !== 200) {
        // Release the unread stream/socket promptly before bailing.
        await response.body?.cancel();
        return {
          query: input.query,
          results: [],
          error: `web search returned HTTP ${response.status}`,
        };
      }
      const contentType = response.headers.get('content-type');
      if (!isAcceptableContentType(contentType)) {
        await response.body?.cancel();
        return {
          query: input.query,
          results: [],
          error: `unexpected content-type: ${contentType ?? '(none)'}`,
        };
      }
      const { body: html } = await readBodyCapped(response, MAX_RESPONSE_CHARS);
      return { query: input.query, results: parseDuckDuckGoHtml(html, n) };
    },
  });
}

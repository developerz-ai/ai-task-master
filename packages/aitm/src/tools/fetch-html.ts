// fetch_html — a heavier-stealth sibling of web-fetch for sites that fingerprint TLS (JA3/JA4)
// or HTTP/2 frame ordering (Cloudflare JS challenge, Akamai Bot Manager). Node's stock `fetch`
// can't fake a browser's TLS handshake, so this shells out to a `curl-impersonate` binary
// (https://github.com/lwthiker/curl-impersonate), which speaks a real Chrome/Firefox/Safari
// handshake. Same WebFetchOutput shape as web-fetch so a subagent can swap tools without prompt
// changes — the model should reach for this only when web-fetch returns a 403/challenge.
//
// curl-impersonate is an OPTIONAL system binary. The tool never hard-fails at startup: when the
// binary is absent the call returns a status-0 result whose body explains how to install it
// (use isFetchHtmlAvailable() at the wiring site to skip registration entirely). No npm dep.

import type { Tool } from 'ai';
import { tool } from 'ai';
import { ExecaError, execa } from 'execa';
import { z } from 'zod';
import {
  defaultLookup,
  type LookupFn,
  renderWebFetchOutput,
  resolveSafeUrl,
  type WebFetchOutput,
} from './web-fetch.ts';

const fetchHtmlInputSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
  impersonate: z.enum(['chrome', 'firefox', 'safari']).optional(),
});

export type FetchHtmlInput = z.infer<typeof fetchHtmlInputSchema>;
export type ImpersonateTarget = z.infer<typeof fetchHtmlInputSchema>['impersonate'];

// Default curl-impersonate target per browser hint. These version strings depend on the
// installed curl-impersonate build — override via FetchHtmlInit.targets to match your version.
export const DEFAULT_IMPERSONATE_TARGETS: Readonly<
  Record<'chrome' | 'firefox' | 'safari', string>
> = Object.freeze({ chrome: 'chrome116', firefox: 'firefox117', safari: 'safari15_5' });

// Default binary — the chrome build ships in most curl-impersonate installs. Point at a
// different binary (e.g. `curl-impersonate-ff`, an absolute path) via FetchHtmlInit.binary.
const DEFAULT_BINARY = 'curl-impersonate-chrome';
const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 15_000;
// Hard ceilings on model-provided inputs so one tool call can't exhaust resources: cap the
// request runtime, and cap maxChars (which also bounds the subprocess maxBuffer below).
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 5_000_000;
// Marker separating curl's `--write-out` metadata (redirected to stderr via %{stderr}) from any
// real stderr noise. Chosen to be vanishingly unlikely to occur in normal output.
const META = '__AITM_FETCH_HTML_META__';

// Minimal shell-exec surface this tool needs — satisfied by execa and by a test stub, so we
// don't have to cast a fake to execa's full overloaded type.
export type ExecLike = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: unknown; stderr: unknown }>;

export type FetchHtmlInit = {
  // curl-impersonate binary name or path. Default `curl-impersonate-chrome`.
  binary?: string;
  // Override the browser-hint → curl `--impersonate` target map for your installed version.
  targets?: Record<'chrome' | 'firefox' | 'safari', string>;
  // DNS lookup for the SSRF guard (shared with web-fetch). Injected in tests.
  lookup?: LookupFn;
  // Test seam — swap out execa to record argv without spawning.
  exec?: ExecLike;
};

function resolveExec(init: FetchHtmlInit): ExecLike {
  return init.exec ?? ((file, args, options) => execa(file, args, options));
}

// Pin curl to the exact IP(s) resolveSafeUrl already validated (`--resolve host:port:ip`), so a
// hostile resolver can't hand our SSRF check a public IP and curl a private one on re-resolution.
// Empty for IP-literal hosts (the host is the address). IPv6 is bracketed for the addr slot.
function resolvePinArgs(url: URL, addresses: readonly string[]): string[] {
  if (addresses.length === 0) return [];
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const pinned = addresses.map((a) => (a.includes(':') ? `[${a}]` : a)).join(',');
  return ['--resolve', `${url.hostname}:${port}:${pinned}`];
}

// True when the curl-impersonate binary is callable. Use at the wiring site to decide whether to
// register fetch_html at all (per CLAUDE.md: gate on "binary present", don't hard-fail).
export async function isFetchHtmlAvailable(init: FetchHtmlInit = {}): Promise<boolean> {
  const exec = resolveExec(init);
  const binary = init.binary ?? DEFAULT_BINARY;
  try {
    await exec(binary, ['--version']);
    return true;
  } catch {
    return false;
  }
}

export function fetchHtmlTool(init: FetchHtmlInit = {}): Tool<FetchHtmlInput, WebFetchOutput> {
  const exec = resolveExec(init);
  const binary = init.binary ?? DEFAULT_BINARY;
  const targets = init.targets ?? DEFAULT_IMPERSONATE_TARGETS;
  const lookup = init.lookup ?? defaultLookup;

  return tool({
    description:
      'Fetch a URL using a real browser TLS fingerprint (via curl-impersonate), for sites that block stock fetch with a JS challenge / 403 (Cloudflare, Akamai). Same output shape as web-fetch. Use this only when web-fetch returns a challenge or 403.',
    inputSchema: fetchHtmlInputSchema,
    execute: async (input: FetchHtmlInput): Promise<WebFetchOutput> => {
      const maxChars = Math.min(input.maxChars ?? DEFAULT_MAX_CHARS, MAX_OUTPUT_CHARS);
      const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const { url: safeUrl, addresses } = await resolveSafeUrl(input.url, lookup);
      const target = targets[input.impersonate ?? 'chrome'];
      // -sS: quiet but show errors. NO -L + --max-redirs 0: never follow redirects — a 3xx
      // Location could aim at a private address and curl would re-resolve+chase it past our SSRF
      // check. --resolve pins the exact IP(s) we validated so curl can't re-resolve to a private
      // one (DNS-rebind TOCTOU). --max-time bounds the request; -w '%{stderr}…' writes the
      // metadata line to STDERR so STDOUT is purely the body.
      const args = [
        '--impersonate',
        target,
        '-sS',
        '--max-redirs',
        '0',
        ...resolvePinArgs(safeUrl, addresses),
        '--max-time',
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        '-w',
        `%{stderr}\n${META}\t%{http_code}\t%{url_effective}\t%{content_type}`,
        safeUrl.toString(),
      ];
      try {
        const r = await exec(binary, args, {
          timeout: timeoutMs + 5_000,
          maxBuffer: maxChars * 4 + 2_000_000,
        });
        return buildOutput(input.url, asString(r.stdout), asString(r.stderr), maxChars);
      } catch (err) {
        // curl ran but returned non-zero (e.g. still blocked, timeout): salvage metadata if present.
        if (err instanceof ExecaError) {
          const parsed = parseMeta(asString(err.stderr));
          if (parsed)
            return buildOutput(input.url, asString(err.stdout), asString(err.stderr), maxChars);
          return errorOutput(input.url, err.shortMessage || err.message);
        }
        return errorOutput(input.url, err instanceof Error ? err.message : String(err));
      }
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: renderWebFetchOutput(output) }),
  });
}

function buildOutput(
  requestedUrl: string,
  stdout: string,
  stderr: string,
  maxChars: number,
): WebFetchOutput {
  const meta = parseMeta(stderr);
  const truncated = stdout.length > maxChars;
  return {
    url: requestedUrl,
    finalUrl: meta?.finalUrl || requestedUrl,
    status: meta?.status ?? 0,
    contentType: meta?.contentType ?? null,
    body: truncated ? stdout.slice(0, maxChars) : stdout,
    truncated,
    retrievedAt: new Date().toISOString(),
  };
}

function parseMeta(
  stderr: string,
): { status: number; finalUrl: string; contentType: string | null } | null {
  const line = stderr
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(META));
  if (!line) return null;
  const [, statusRaw, finalUrl, contentType] = line.split('\t');
  const status = Number.parseInt(statusRaw ?? '', 10);
  return {
    status: Number.isFinite(status) ? status : 0,
    finalUrl: finalUrl ?? '',
    contentType: contentType && contentType.length > 0 ? contentType : null,
  };
}

function errorOutput(requestedUrl: string, message: string): WebFetchOutput {
  return {
    url: requestedUrl,
    finalUrl: requestedUrl,
    status: 0,
    contentType: null,
    body: `fetch_html failed: ${message}. Is curl-impersonate installed and on PATH? See https://github.com/lwthiker/curl-impersonate`,
    truncated: false,
    retrievedAt: new Date().toISOString(),
  };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

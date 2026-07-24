// OAuth 2.0 authorization code flow for MCP servers.
// Spawns a temporary loopback HTTP server to capture the OAuth callback,
// exchanges the authorization code for an access token, and returns the
// authenticated server configuration. Cross-runtime: Bun, Node ≥20, Deno ≥1.40.
// Refs: RFC 8252 §7.3 (loopback redirect), §8.3 (IP literal, never `localhost`),
// MCP OAuth 2.1 spec.

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_PORT = 8787;
const PORT_RANGE = { min: 8787, max: 9000 };
const STATE_LENGTH = 32;
const PKCE_VERIFIER_BYTES = 32;
const CALLBACK_PATH = '/callback';
const DEFAULT_CLIENT_ID = 'aitm-cli';
// Cap every discovery probe so a slow or wedged metadata endpoint can't stall `mcp-login`.
const DISCOVERY_TIMEOUT_MS = 10000;
const WELL_KNOWN_AS = '/.well-known/oauth-authorization-server';

// RFC 8252 §8.3: bind and redirect to the IP literal. `localhost` resolves via
// DNS and can point somewhere other than the loopback interface.
export const LOOPBACK_HOST = '127.0.0.1';

export function loopbackCallbackUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
}

type Transport = 'http' | 'sse';

export type OAuthCallbackResult =
  | { code: string; state: string }
  | { error: string; errorDescription?: string; state?: string };

export type OAuthConfig = {
  name: string;
  type: Transport;
  url: string;
  headers: { Authorization: string };
};

export type OAuthOptions = {
  // The canonical MCP server URL, used verbatim as the resulting config `url` and to derive the
  // server name. Passed through explicitly rather than reverse-engineered from `authUrl` — a
  // discovered `authUrl` may live on a different host/path than the server it authorizes.
  serverUrl: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  callbackUrl?: string;
  port?: number;
  timeout?: number;
  openBrowser?: (url: string) => Promise<void>;
  // Sink for operator-visible warnings (e.g. an ignored state-mismatch callback). Defaults to
  // stderr; injected in tests to assert a mismatch is surfaced rather than silently swallowed.
  onWarn?: (message: string) => void;
};

type ServerResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

// Generate cryptographically random state for CSRF protection.
function generateState(): string {
  return randomBytes(STATE_LENGTH).toString('base64url');
}

type PkcePair = { verifier: string; challenge: string };

// RFC 7636 S256 PKCE. MCP OAuth 2.1 mandates PKCE for the authorization-code flow,
// including public clients like the default `aitm-cli` that carry no client secret.
// The verifier is a base64url random string; the challenge is BASE64URL(SHA256(verifier)).
function generatePkcePair(): PkcePair {
  const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Find an available port in the configured range.
async function findAvailablePort(start: number, end: number): Promise<number> {
  const net = await import('node:net');

  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > end) {
        reject(new Error(`No available ports in range ${start}-${end}`));
        return;
      }

      const server = net.createServer();
      server.listen(port, LOOPBACK_HOST, () => {
        server.once('close', () => resolve(port));
        server.close();
      });
      server.on('error', () => tryPort(port + 1));
    };

    tryPort(start);
  });
}

// The port a caller-supplied `callbackUrl` names, if any. The loopback server must bind this exact
// port — the authorization server redirects to `callbackUrl`, so a mismatched bind means the
// callback never arrives and the flow times out.
function portFromUrl(rawUrl: string): number | undefined {
  try {
    const { port } = new URL(rawUrl);
    if (port === '') return undefined;
    const parsed = Number(port);
    return Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// The minimal launched-process surface `openBrowser` touches. `ChildProcess` satisfies it
// structurally, so the default launcher needs no cast (strict TS bans `as unknown as`).
type LaunchedProcess = {
  on(event: 'error', listener: (err: Error) => void): void;
  unref(): void;
};

// Spawn seam: turns the resolved platform command into a launched process. Injectable so the
// headless-host error handling below is driven by tests without a real spawn.
export type BrowserLauncher = (command: string, args: string[]) => LaunchedProcess;

async function defaultBrowserLauncher(): Promise<BrowserLauncher> {
  const { spawn } = await import('node:child_process');
  return (command, args) =>
    spawn(command, args, {
      detached: true,
      shell: process.platform === 'win32',
      stdio: 'ignore',
    });
}

// Browser launching by platform. Exported so the spawn-error path is exercised through this real
// handler rather than a test-local reimplementation.
export async function openBrowser(url: string, launcher?: BrowserLauncher): Promise<void> {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  const args = platform === 'win32' ? ['/D', url] : [url];

  const launch = launcher ?? (await defaultBrowserLauncher());
  const proc = launch(command, args);

  proc.on('error', () => {
    // Silently ignore spawn errors (common on headless hosts where browser launchers
    // like xdg-open don't exist). The OAuth flow can continue; the user can open the
    // URL manually if needed.
  });

  proc.unref();
}

// HTML pages for success/error feedback.
async function loadHtmlTemplate(name: 'success' | 'error'): Promise<string> {
  const templatePath = fileURLToPath(
    join(dirname(import.meta.url), '..', 'templates', `oauth-${name}.html`),
  );

  try {
    return await readFile(templatePath, 'utf8');
  } catch {
    return getDefaultHtml(name);
  }
}

function getDefaultHtml(type: 'success' | 'error'): string {
  if (type === 'success') {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Successful</title>
          <style>
            body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #fafafa; }
            .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            h1 { color: #10b981; margin-bottom: 0.5rem; }
            p { color: #6b7280; margin: 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Authorization successful!</h1>
            <p>You can now close this window and return to your terminal.</p>
          </div>
        </body>
      </html>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Authorization Failed</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #fafafa; }
          .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          h1 { color: #ef4444; margin-bottom: 0.5rem; }
          p { color: #6b7280; margin: 0; }
          .error { color: #dc2626; font-family: monospace; font-size: 0.875rem; margin-top: 1rem; padding: 0.5rem; background: #fee2e2; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>❌ Authorization failed</h1>
          <p>{{error}}</p>
          <div class="error">{{error_description}}</div>
        </div>
      </body>
    </html>
  `;
}

// Node.js HTTP server implementation using native http module.
class NodeServer {
  private server?: import('node:http').Server;
  private resolver?: (value: OAuthCallbackResult) => void;
  private callbackPath?: string;
  private expectedState?: string;

  constructor(
    private successHtmlTemplate: string,
    private errorHtmlTemplate: string,
    private onWarn: (message: string) => void,
  ) {}

  async start(port: number): Promise<number> {
    const http = await import('node:http');
    const url = await import('node:url');

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const requestUrl = new url.URL(req.url || '', `http://${LOOPBACK_HOST}:${port}`);
        const response = await this.handleRequest(requestUrl);

        res.writeHead(response.status, response.headers);
        res.end(response.body);
      });

      this.server.listen(port, LOOPBACK_HOST, () => resolve(port));
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  waitForCallback(path: string, timeout: number, state: string): Promise<OAuthCallbackResult> {
    this.callbackPath = path;
    this.expectedState = state;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`OAuth callback timeout after ${timeout}ms`));
      }, timeout);

      this.resolver = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }

  private async handleRequest(requestUrl: URL): Promise<ServerResponse> {
    if (requestUrl.pathname !== this.callbackPath) {
      return { status: 404, headers: {}, body: 'Not Found' };
    }

    const params = Object.fromEntries(requestUrl.searchParams.entries());

    // CSRF protection: a callback whose state does not match the one we issued is an unexpected or
    // forged request. Reject this request but keep waiting for the authorized callback (the timeout
    // is the backstop), and surface a warning so the wait is not a silent hang.
    if (this.expectedState && params.state !== this.expectedState) {
      this.onWarn(
        'OAuth callback ignored: state parameter mismatch (possible CSRF probe); still waiting for the authorized callback',
      );
      return this.errorResponse(
        'invalid_request',
        'State parameter mismatch - possible CSRF attack',
      );
    }

    // A callback carrying neither a non-empty `code` nor an `error` is malformed; resolving it would
    // post `code=undefined` to the token endpoint. Ignore it and keep waiting.
    const result = parseCallback(params);
    if (!result) {
      this.onWarn(
        'OAuth callback ignored: neither authorization code nor error present; still waiting for the authorized callback',
      );
      return this.errorResponse('invalid_request', 'Callback missing authorization code or error');
    }

    const body =
      'error' in result
        ? this.errorHtmlTemplate
            .replace('{{error}}', result.error)
            .replace('{{error_description}}', result.errorDescription ?? '')
        : this.successHtmlTemplate;

    this.resolver?.(result);

    return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body };
  }

  private errorResponse(error: string, description: string): ServerResponse {
    return {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: this.errorHtmlTemplate
        .replace('{{error}}', error)
        .replace('{{error_description}}', description),
    };
  }
}

// Parse the OAuth callback query into a validated result. Returns `undefined` when the callback
// carries neither a non-empty authorization `code` (success) nor an `error` (failure) — a malformed
// request that must not resolve the flow. Maps the wire-format `error_description` onto the internal
// camelCase field.
export function parseCallback(params: Record<string, string>): OAuthCallbackResult | undefined {
  if (typeof params.error === 'string' && params.error.length > 0) {
    const result: { error: string; errorDescription?: string; state?: string } = {
      error: params.error,
    };
    if (params.error_description) result.errorDescription = params.error_description;
    if (params.state) result.state = params.state;
    return result;
  }

  if (typeof params.code === 'string' && params.code.length > 0) {
    return { code: params.code, state: params.state ?? '' };
  }

  return undefined;
}

// Main OAuth flow orchestrator.
export async function performOAuthFlow(options: OAuthOptions): Promise<OAuthConfig> {
  const port =
    options.port ??
    (options.callbackUrl ? portFromUrl(options.callbackUrl) : undefined) ??
    (await findAvailablePort(DEFAULT_PORT, PORT_RANGE.max));
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const state = generateState();
  const pkce = generatePkcePair();
  const callbackPath = CALLBACK_PATH;
  const callbackUrl = options.callbackUrl ?? loopbackCallbackUrl(port);
  const onWarn: (message: string) => void =
    options.onWarn ?? ((message) => process.stderr.write(`${message}\n`));

  const successHtml = await loadHtmlTemplate('success');
  const errorHtml = await loadHtmlTemplate('error');

  // Build authorization URL with required parameters
  const authParams = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  });

  if (options.scope) {
    authParams.set('scope', options.scope);
  }

  const authUrl = `${options.authUrl}?${authParams.toString()}`;

  // Start callback server
  const server = new NodeServer(successHtml, errorHtml, onWarn);
  await server.start(port);

  try {
    // Launch browser
    await (options.openBrowser ?? openBrowser)(authUrl);

    // Wait for callback
    const result = await server.waitForCallback(callbackPath, timeout, state);

    if ('error' in result) {
      throw new Error(
        `OAuth error: ${result.error}${result.errorDescription ? ` (${result.errorDescription})` : ''}`,
      );
    }

    // Exchange authorization code for access token
    const tokenResponse = await exchangeToken(
      options.tokenUrl,
      options.clientId,
      result.code,
      callbackUrl,
      pkce.verifier,
      options.clientSecret,
    );

    const name = extractServerName(options.serverUrl);
    return {
      name,
      type: 'http',
      url: options.serverUrl,
      headers: {
        Authorization: `Bearer ${tokenResponse.access_token}`,
      },
    };
  } finally {
    await server.stop();
  }
}

// Exchange authorization code for access token.
async function exchangeToken(
  tokenUrl: string,
  clientId: string,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  clientSecret?: string,
): Promise<{ access_token: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  if (clientSecret !== undefined) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText}\n${text}`);
  }

  const data: unknown = await response.json();

  if (!isRecord(data)) {
    throw new Error('Token exchange returned a non-object response');
  }

  if (typeof data.error === 'string' && data.error.length > 0) {
    throw new Error(`Token exchange error: ${data.error}`);
  }

  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('Token exchange response is missing a non-empty access_token');
  }

  return { access_token: data.access_token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Extract a server name from a URL's host.
function extractServerName(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    const hostname = url.hostname.replace(/^www\./, '');
    return hostname.replace(/[.-]/g, '-');
  } catch {
    return 'mcp-server';
  }
}

// ---- endpoint discovery ----------------------------------------------------

export type OAuthEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
};

export type DiscoveryDeps = {
  fetch?: typeof fetch;
  onWarn?: (message: string) => void;
};

export type McpOAuthLoginInput = {
  serverUrl: string;
  clientId?: string;
  scope?: string;
  callbackUrl?: string;
  timeout?: number;
  // Seams (defaulted in production; injected in tests).
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  onWarn?: (message: string) => void;
};

// Resolve an MCP server's OAuth authorization and token endpoints.
//
// Discovery order, per the MCP OAuth spec: (1) probe the server for an RFC 9728 `WWW-Authenticate`
// challenge naming its authorization server; (2) fetch that server's RFC 8414 metadata document.
// When discovery yields nothing (dev servers, non-conformant deployments) we fall back to the
// conventional `${origin}/oauth/authorize` + `/oauth/token` endpoints rather than failing outright.
export async function discoverOAuthEndpoints(
  serverUrl: string,
  deps: DiscoveryDeps = {},
): Promise<OAuthEndpoints> {
  const origin = new URL(serverUrl).origin;
  const doFetch = deps.fetch ?? fetch;
  const onWarn = deps.onWarn ?? ((message) => process.stderr.write(`${message}\n`));

  const issuer = (await probeAuthorizationServer(serverUrl, doFetch)) ?? origin;
  const metadata = await fetchAuthServerMetadata(issuer, doFetch);
  if (metadata) {
    return {
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
    };
  }

  onWarn(
    `OAuth endpoint discovery failed for ${issuer}; falling back to ${origin}/oauth/authorize and /oauth/token`,
  );
  return {
    authorizationEndpoint: `${origin}/oauth/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
  };
}

// End-to-end MCP OAuth login: discover endpoints, resolve the client id, then run the flow. Owns
// all endpoint derivation so the CLI only forwards the server URL and user-supplied overrides.
export async function loginToMcpServer(input: McpOAuthLoginInput): Promise<OAuthConfig> {
  const discoveryDeps: DiscoveryDeps = {};
  if (input.fetch) discoveryDeps.fetch = input.fetch;
  if (input.onWarn) discoveryDeps.onWarn = input.onWarn;
  const endpoints = await discoverOAuthEndpoints(input.serverUrl, discoveryDeps);

  const options: OAuthOptions = {
    serverUrl: input.serverUrl,
    authUrl: endpoints.authorizationEndpoint,
    tokenUrl: endpoints.tokenEndpoint,
    clientId: input.clientId ?? clientIdFromServerUrl(input.serverUrl),
  };
  if (input.scope) options.scope = input.scope;
  if (input.callbackUrl) options.callbackUrl = input.callbackUrl;
  if (input.timeout) options.timeout = input.timeout;
  if (input.openBrowser) options.openBrowser = input.openBrowser;
  if (input.onWarn) options.onWarn = input.onWarn;

  return performOAuthFlow(options);
}

// A public client has no registered id; honor a `client_id` query param (a common dev convenience)
// and otherwise fall back to the `aitm-cli` public-client id.
function clientIdFromServerUrl(serverUrl: string): string {
  try {
    return new URL(serverUrl).searchParams.get('client_id') ?? DEFAULT_CLIENT_ID;
  } catch {
    return DEFAULT_CLIENT_ID;
  }
}

type AuthServerMetadata = { authorization_endpoint: string; token_endpoint: string };

// RFC 9728 §5.1: an unauthenticated request answered with `WWW-Authenticate: Bearer
// resource_metadata="…"` points at the protected-resource metadata, whose `authorization_servers`
// names the issuer. Any failure along the way degrades to "no issuer found" (undefined).
async function probeAuthorizationServer(
  serverUrl: string,
  doFetch: typeof fetch,
): Promise<string | undefined> {
  const headers = await fetchHead(serverUrl, doFetch);
  const header = headers?.get('www-authenticate');
  if (!header) return undefined;

  const resourceMetadataUrl = resourceMetadataFromHeader(header);
  if (!resourceMetadataUrl) return undefined;

  const prm = await fetchJson(resourceMetadataUrl, doFetch);
  if (!isRecord(prm) || !Array.isArray(prm.authorization_servers)) return undefined;
  return prm.authorization_servers.find((s): s is string => typeof s === 'string' && s.length > 0);
}

function resourceMetadataFromHeader(header: string): string | undefined {
  return /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)?.[1];
}

async function fetchAuthServerMetadata(
  issuer: string,
  doFetch: typeof fetch,
): Promise<AuthServerMetadata | undefined> {
  for (const url of metadataCandidates(issuer)) {
    const metadata = parseAuthServerMetadata(await fetchJson(url, doFetch));
    if (metadata) return metadata;
  }
  return undefined;
}

// RFC 8414 §3 inserts the well-known segment between host and issuer path; some providers instead
// append it. Both collapse to one URL for a path-less issuer.
function metadataCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  const rfc8414 = `${url.origin}${WELL_KNOWN_AS}${path}`;
  if (path === '') return [rfc8414];
  return [rfc8414, `${url.origin}${path}${WELL_KNOWN_AS}`];
}

function parseAuthServerMetadata(data: unknown): AuthServerMetadata | undefined {
  if (!isRecord(data)) return undefined;
  const authorization = data.authorization_endpoint;
  const token = data.token_endpoint;
  if (!isAbsoluteHttpUrl(authorization) || !isAbsoluteHttpUrl(token)) return undefined;
  return { authorization_endpoint: authorization, token_endpoint: token };
}

function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// A timed GET, or undefined on network error/timeout. The caller owns the body: consume it (via
// `fetchJson`) or drop it (via `fetchHead`) — an unread body would hold the connection open.
async function fetchWithTimeout(url: string, doFetch: typeof fetch): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(
    () => controller.abort(),
    DISCOVERY_TIMEOUT_MS,
  );
  try {
    return await doFetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function dropBody(res: Response): void {
  if (res.body) void res.body.cancel().catch(() => {});
}

// GET returning only the response headers (a 401 is a valid probe result, not a failure); the body
// is discarded since the probe reads nothing from it.
async function fetchHead(url: string, doFetch: typeof fetch): Promise<Headers | undefined> {
  const res = await fetchWithTimeout(url, doFetch);
  if (!res) return undefined;
  dropBody(res);
  return res.headers;
}

async function fetchJson(url: string, doFetch: typeof fetch): Promise<unknown> {
  const res = await fetchWithTimeout(url, doFetch);
  if (!res) return undefined;
  if (!res.ok) {
    dropBody(res);
    return undefined;
  }
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

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
  const port = options.port ?? (await findAvailablePort(DEFAULT_PORT, PORT_RANGE.max));
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

    const name = extractServerName(options.authUrl);
    return {
      name,
      type: 'http',
      url: options.authUrl.replace(/\/oauth\/authorize.*/, ''),
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

// Extract a server name from the authorization URL.
function extractServerName(authUrl: string): string {
  try {
    const url = new URL(authUrl);
    const hostname = url.hostname.replace(/^www\./, '');
    return hostname.replace(/[.-]/g, '-');
  } catch {
    return 'mcp-server';
  }
}

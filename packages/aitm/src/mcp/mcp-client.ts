// Connects to every MCP server declared in `mcpServers` (config) and exposes the
// union of their tools to subagents. The Vercel AI SDK's @ai-sdk/mcp client gives
// us tool-conversion; we wire transport per entry and merge the tool maps.
//
// docs/vendor/ai-sdk/chunk-15.md §"Initializing an MCP Client"
// docs/mcp.md
//
// Lifecycle: connectAll() at run start, toolsForRole() during agent build, close() on exit
// (success / blocked / SIGINT). Failures on individual servers are logged + skipped — a
// broken MCP server should not block the whole run. Every stdio server's child pid is handed to
// StdioProcessRegistry, which outlives close() as the guarantee that none of them zombie.

import { experimental_createMCPClient, type MCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { ToolSet } from 'ai';
import { DEFAULT_MCP_DEFER_TOOLS_OVER } from '../config/defaults.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import type { Role } from '../domain/role.ts';
import type { LoggerLike } from '../logger/logger.ts';
import type { McpRoleAllowlist, McpRoleAllowlistValue, McpServer, McpServers } from './schema.ts';
import { StdioProcessRegistry } from './stdio-process-registry.ts';

export type TransportKind = 'stdio' | 'http' | 'sse';

export type CreateMcpClient = (config: MCPClientConfig) => Promise<MCPClient>;

// One server's connect — createClient plus its first tools() listing — is bounded by this deadline:
// a stdio server that spawns but never completes the MCP handshake (createClient resolves, tools()
// never does) would otherwise hang connectAll forever. Generous enough for a cold `npx` that fetches
// the server package on first run, tight enough that a wedged server can't stall the whole run.
// Overridable per-manager via connectTimeoutMs; `<= 0` disables the deadline.
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;

// The whole close() batch of graceful client.close() calls is bounded by this before the process
// registry's terminate() runs regardless. Kept short — terminate() (SIGTERM, grace, SIGKILL) is the
// real teardown guarantee; client.close() is only the polite ask. Overridable via closeTimeoutMs;
// `<= 0` disables.
export const DEFAULT_MCP_CLOSE_TIMEOUT_MS = 5_000;

// The role's MCP tools split by how they enter the agent: `direct` are mounted with full schemas;
// `deferred` are surfaced name-only and fetched on demand through `tool_search` (issue #119).
export type ToolSurface = { direct: ToolSet; deferred: ToolSet };

export type McpClientInit = {
  servers: McpServers;
  // Optional per-role allowlist (issue #115). Per role, either whole servers by name
  // (`{ worker: ['filesystem'] }`) or per-server tool patterns with `*` wildcards
  // (`{ planner: { filesystem: ['read_*', 'list_*'] } }`). Unlisted roles get every connected server.
  roleAllowlist?: McpRoleAllowlist;
  // Defer a role's MCP tools once their count exceeds this (issue #119). Default
  // DEFAULT_MCP_DEFER_TOOLS_OVER; 0 = always defer. See toolSurfaceForRole.
  deferToolsOver?: number;
  // Deadline (ms) for one server's connect — createClient + its first tools() call, raced together.
  // Default DEFAULT_MCP_CONNECT_TIMEOUT_MS; `<= 0` disables. Stops a server that spawns but never
  // handshakes from hanging connectAll forever.
  connectTimeoutMs?: number;
  // Deadline (ms) for the whole close() batch before terminate() runs regardless. Default
  // DEFAULT_MCP_CLOSE_TIMEOUT_MS; `<= 0` disables. A wedged client.close() must not block
  // child-process termination.
  closeTimeoutMs?: number;
  // Injection seam for tests — defaults to the AI SDK factory.
  createClient?: CreateMcpClient;
  // Child-process bookkeeping for stdio servers. Injected by tests; production builds its own.
  processes?: StdioProcessRegistry;
  logger?: LoggerLike;
};

type ConnectedServer = {
  name: string;
  transport: TransportKind;
  client: MCPClient;
  tools: ToolSet;
};

// The manager init an adapter builds from resolved config. Extracted because both adapters need it
// and hand-copying the field list is how `mcpDeferToolsOver` came to be dropped: the key is defined
// in the schema, layer-merged with source tracking, and documented in config.md and mcp.md with a
// default of 20 — yet it reached no manager at all, so setting it did nothing (issue #339).
export function mcpInitFrom(
  resolved: Pick<ResolvedConfig, 'mcpServers' | 'mcpDeferToolsOver' | 'mcpRoleAllowlist'>,
  logger?: LoggerLike,
): McpClientInit {
  return {
    servers: resolved.mcpServers,
    deferToolsOver: resolved.mcpDeferToolsOver,
    ...(resolved.mcpRoleAllowlist !== undefined
      ? { roleAllowlist: resolved.mcpRoleAllowlist }
      : {}),
    ...(logger ? { logger } : {}),
  };
}

export class McpClientManager {
  private readonly createClient: CreateMcpClient;
  private readonly processes: StdioProcessRegistry;
  private servers: ConnectedServer[] = [];

  constructor(private readonly init: McpClientInit) {
    this.createClient = init.createClient ?? experimental_createMCPClient;
    this.processes =
      init.processes ?? new StdioProcessRegistry(init.logger ? { logger: init.logger } : {});
  }

  async connectAll(): Promise<void> {
    const connectTimeoutMs = this.init.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    const closeTimeoutMs = this.init.closeTimeoutMs ?? DEFAULT_MCP_CLOSE_TIMEOUT_MS;
    // Connect every server concurrently, not one after another: each handshake is bounded by
    // connectTimeoutMs and a cold `npx` server can take seconds to fetch its package, so N serial
    // connects would add up to N × that latency. allSettled because connectOne owns its own failure —
    // it logs, closes, and registers the child pid, then resolves to undefined — so one broken server
    // can never reject the batch.
    const outcomes = await Promise.allSettled(
      Object.entries(this.init.servers).map(([name, server]) =>
        this.connectOne(name, server, connectTimeoutMs, closeTimeoutMs),
      ),
    );
    // Push fulfilled connections in input order (allSettled preserves the input order) so
    // connected()/toolsForRole ordering stays deterministic instead of racing on handshake finish time.
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled' && outcome.value) this.servers.push(outcome.value);
    }
    this.warnOnSanitizationCollisions();
  }

  // Detect and warn about server name collisions after sanitization (issue #80). When multiple
  // servers' names map to the same sanitized form (e.g., `my.server`, `my server`, `my/server` all
  // become `my-server`), the tools from each are merged under a single namespaced prefix, causing
  // silent overwrites. Warn so the user can rename servers to avoid collisions.
  private warnOnSanitizationCollisions(): void {
    const sanitizedToOriginals = new Map<string, string[]>();
    for (const s of this.servers) {
      const sanitized = sanitizeServerName(s.name);
      const originals = sanitizedToOriginals.get(sanitized) ?? [];
      originals.push(s.name);
      sanitizedToOriginals.set(sanitized, originals);
    }

    for (const [sanitized, originals] of sanitizedToOriginals) {
      if (originals.length > 1) {
        this.init.logger?.warn('mcp server name collision after sanitization', {
          sanitized,
          colliding: originals,
        });
      }
    }
  }

  // Connect one server under a single deadline (createClient + its first tools() call, raced together)
  // and return the ConnectedServer, or undefined when it failed. Never rejects: a broken server is
  // logged and skipped so it cannot take down the whole batch.
  private async connectOne(
    name: string,
    server: McpServer,
    connectTimeoutMs: number,
    closeTimeoutMs: number,
  ): Promise<ConnectedServer | undefined> {
    // client and config live across try/catch/finally: the catch closes a client that connected before
    // its tools() call wedged, and the finally snapshots the spawned child's pid. buildClientConfig is
    // inside the try so a throwing transport constructor is skipped like any other per-server failure
    // rather than rejecting the whole batch.
    let client: MCPClient | undefined;
    let config: MCPClientConfig | undefined;
    try {
      const transport = transportKind(server);
      config = buildClientConfig(name, server);
      // Capture a non-optional handle for the closure: `config` is a `let` the finally reads, so TS
      // cannot narrow it to non-undefined where the closure closes over it.
      const cfg = config;
      // `client` is assigned inside the raced work so the catch can still close a client that connected
      // before its tools() call wedged; a createClient that never resolves leaves it undefined — the
      // child pid registered in `finally` is the reap guarantee there.
      const connected = await withDeadline(
        (async (): Promise<{ client: MCPClient; tools: ToolSet }> => {
          const c = await this.createClient(cfg);
          client = c;
          const tools = (await c.tools()) as ToolSet;
          return { client: c, tools };
        })(),
        connectTimeoutMs,
        'connect',
      );
      return { name, transport, client: connected.client, tools: connected.tools };
    } catch (err) {
      if (client) {
        try {
          // Time-box the cleanup close too, or a wedged server just moves the hang from the connect
          // to here and still blocks the batch.
          await withDeadline(client.close(), closeTimeoutMs, 'close');
        } catch (closeErr) {
          this.init.logger?.warn('mcp server cleanup failed', {
            name,
            error: errorMessage(closeErr),
          });
        }
      }
      this.init.logger?.warn('mcp server connect failed', { name, error: errorMessage(err) });
      return undefined;
    } finally {
      // In `finally`, not the success path: a connect that dies mid-handshake has already spawned the
      // child, and that is exactly the pid most likely to be left behind. Registering an already-dead
      // pid is a no-op — the registry probes liveness before it signals.
      if (config !== undefined) {
        const pid = stdioPid(config.transport);
        if (pid !== undefined) this.processes.register(name, pid);
      }
    }
  }

  // Every tool is mounted under the Claude Code convention `mcp__<server>__<tool>`, so name overlaps
  // across servers no longer collide (both survive as distinct keys — no drop, no warning). The
  // allowlist gates servers (array form) or individual tools (record form) per role (issue #115).
  toolsForRole(role: Role): ToolSet {
    const allowed = this.init.roleAllowlist?.[role];
    const merged: ToolSet = {};
    for (const s of this.servers) {
      const toolFilter = serverToolFilter(allowed, s.name);
      if (toolFilter === null) continue; // this server is not mounted for the role
      for (const [toolName, tool] of Object.entries(s.tools)) {
        if (!toolFilter(toolName)) continue;
        merged[namespacedName(s.name, toolName)] = tool;
      }
    }
    return merged;
  }

  // Split the role's MCP tools into directly-mounted vs. deferred (issue #119). At or below the
  // threshold the whole set is `direct` — byte-identical to plain mounting, no stubs, no tool_search.
  // Above it the whole surplus is `deferred`, surfaced name-only and fetched via tool_search. The
  // fixed local slots (readFile, bash, …) live in the adapter, not here, so every MCP tool counts.
  toolSurfaceForRole(role: Role): ToolSurface {
    const tools = this.toolsForRole(role);
    const threshold = this.init.deferToolsOver ?? DEFAULT_MCP_DEFER_TOOLS_OVER;
    if (Object.keys(tools).length <= threshold) return { direct: tools, deferred: {} };
    return { direct: {}, deferred: tools };
  }

  async close(): Promise<void> {
    const toClose = this.servers;
    this.servers = [];
    const closeTimeoutMs = this.init.closeTimeoutMs ?? DEFAULT_MCP_CLOSE_TIMEOUT_MS;
    try {
      // Time-box the whole graceful-close batch. Each client.close() already swallows its own error,
      // so the only way this rejects is the deadline — and on it we fall through to terminate() anyway.
      await withDeadline(
        Promise.all(
          toClose.map(async (s) => {
            try {
              await s.client.close();
            } catch (err) {
              this.init.logger?.warn('mcp server close failed', {
                name: s.name,
                error: errorMessage(err),
              });
            }
          }),
        ),
        closeTimeoutMs,
        'close',
      );
    } catch (err) {
      this.init.logger?.warn('mcp close batch timed out', { error: errorMessage(err) });
    }
    // Always, even if a client.close() hung or the whole batch timed out: a graceful close that never
    // returns must not decide whether the child process survives the run. terminate() SIGTERMs then
    // SIGKILLs every tracked pid — the guarantee the old unbounded Promise.all only claimed to make.
    await this.processes.terminate();
  }

  connected(): Array<{ name: string; toolCount: number; transport: string }> {
    return this.servers.map((s) => ({
      name: s.name,
      toolCount: Object.keys(s.tools).length,
      transport: s.transport,
    }));
  }
}

function transportKind(server: McpServer): TransportKind {
  if ('url' in server) return server.type;
  return 'stdio';
}

function buildClientConfig(name: string, server: McpServer): MCPClientConfig {
  if ('url' in server) {
    const transport: MCPClientConfig['transport'] = server.headers
      ? { type: server.type, url: server.url, headers: server.headers }
      : { type: server.type, url: server.url };
    return { transport, clientName: clientNameFor(name) };
  }

  const stdio = new Experimental_StdioMCPTransport({
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
  });
  return { transport: stdio, clientName: clientNameFor(name) };
}

function clientNameFor(name: string): string {
  return `aitm-${name}`;
}

// The spawned child's pid, read off the SDK's stdio transport after connect. The SDK exposes no
// accessor, so this narrows the runtime shape structurally (`in` checks, no casts) and returns
// undefined for every non-stdio transport and for a spawn that never happened.
function stdioPid(transport: MCPClientConfig['transport']): number | undefined {
  if (typeof transport !== 'object' || transport === null) return undefined;
  if (!('process' in transport)) return undefined;
  const proc: unknown = transport.process;
  if (typeof proc !== 'object' || proc === null || !('pid' in proc)) return undefined;
  const pid: unknown = proc.pid;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

// `mcp__<server>__<tool>`, the Claude Code namespacing convention (issue #115). Server names are
// sanitized to the OpenAI-compatible function-name charset; they should avoid `__` so the split back
// to <server>/<tool> stays unambiguous (documented in docs/mcp.md).
function namespacedName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeServerName(serverName)}__${toolName}`;
}

function sanitizeServerName(name: string): string {
  // Collapse any run of 2+ underscores to `-` as well: `__` is the namespace delimiter, so a server
  // name containing it (`my__server`) would make mcpBaseName mis-split `mcp__my__server__tool`.
  return name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/_{2,}/g, '-');
}

// Resolve the per-role, per-server tool gate (issue #115). Returns a predicate over un-namespaced
// tool names, or null when the server is not mounted for the role:
//   allowed undefined        → every server, every tool
//   string[] (whole servers) → this server iff listed, then every tool
//   Record<string,string[]>  → this server iff a key, then tools matching its `*`-glob patterns
function serverToolFilter(
  allowed: McpRoleAllowlistValue | undefined,
  serverName: string,
): ((toolName: string) => boolean) | null {
  if (allowed === undefined) return () => true;
  if (Array.isArray(allowed)) return allowed.includes(serverName) ? () => true : null;
  // Own-property only: a server named `toString`/`__proto__` must not read an inherited member
  // (which would make `.some(...)` throw and abort role resolution).
  const patterns = Object.hasOwn(allowed, serverName) ? allowed[serverName] : undefined;
  if (patterns === undefined) return null;
  return (toolName) => patterns.some((pattern) => matchesGlob(toolName, pattern));
}

// `*` matches any run of characters; every other character is literal (no other metacharacters).
function matchesGlob(name: string, pattern: string): boolean {
  const body = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`).test(name);
}

// Race a lifecycle promise against a timer so an SDK call that never settles (a stdio server wedged
// mid-handshake, a client.close() that no-ops) cannot hang the run. `ms <= 0` disables the deadline.
// The losing side of the race is abandoned but harmless: on the op's win the timer is cleared, and on
// the deadline's win the op stays pending with nothing awaiting it. A dedicated timer (not the
// package's defaultSleep) is deliberate — defaultSleep collapses to a microtask under the test runner,
// which would fire every deadline instantly.
async function withDeadline<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return op;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`mcp ${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

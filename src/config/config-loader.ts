// docs/config.md §"Resolution order", docs/auth.md §"LLM provider"
// Only module allowed to read ~/.aitm.json and .ai-task-master/config.json.
// Merge order: defaults < global < project < env < CLI flags. Frozen snapshot written by writeSnapshot().

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError, z } from 'zod';
import { DEFAULT_MODELS } from '../credentials/defaults.ts';
import { atomicWrite } from '../fs/atomic-write.ts';
import { type McpServers, McpServersSchema } from '../mcp/schema.ts';
import {
  type CliOverrides,
  type ConfigFile,
  ConfigFileSchema,
  type McpServerSource,
  type ResolvedConfig,
} from './schema.ts';

const GLOBAL_FILE = '.aitm.json';
const PROJECT_DIR = '.ai-task-master';
const PROJECT_FILE = 'config.json';
const SNAPSHOT_FILE = 'config.snapshot.json';
// Claude Code's standard MCP config files. Discovering these lets users plug aitm into
// the same MCP servers their Claude Code session already uses, without re-declaring them.
// Refs: https://code.claude.com/docs/en/mcp ("Project scope" = .mcp.json in project root;
// "User scope" = ~/.claude.json with an mcpServers key).
const CLAUDE_PROJECT_MCP_FILE = '.mcp.json';
const CLAUDE_USER_FILE = '.claude.json';

const KNOWN_KEYS = new Set<string>([
  'openrouterApiKey',
  'models',
  'maxPrs',
  'maxSessions',
  'autoMerge',
  'mergeMethod',
  'stylePath',
  'logLevel',
  'concurrency',
  'mcpServers',
]);

const DEFAULTS = {
  maxPrs: 5,
  maxSessions: null as number | null,
  autoMerge: true,
  mergeMethod: 'squash' as const,
  stylePath: null as string | null,
  logLevel: 'info' as const,
  concurrency: 1,
};

type WarnFn = (msg: string) => void;

export type ConfigLoaderOptions = {
  warn?: WarnFn;
};

export class ConfigLoader {
  private readonly warn: WarnFn;

  constructor(
    private readonly cwd: string,
    private readonly homeDir: string,
    private readonly env: Record<string, string | undefined>,
    options?: ConfigLoaderOptions,
  ) {
    this.warn = options?.warn ?? ((msg) => process.stderr.write(`${msg}\n`));
  }

  async resolve(cliOverrides: CliOverrides): Promise<ResolvedConfig> {
    const global = await this.readGlobal();
    const project = await this.readProject();
    const claudeUser = await this.readClaudeUserMcp();
    const claudeProject = await this.readClaudeProjectMcp();

    const { apiKey, apiKeySource } = this.resolveApiKey(global, project);

    if (apiKey === undefined || apiKeySource === undefined) {
      throw new Error(
        'No OpenRouter API key found. Set OPENROUTER_API_KEY env, or add ' +
          '"openrouterApiKey" to ~/.aitm.json or ./.ai-task-master/config.json.',
      );
    }

    const { mcpServers, mcpServerSources } = this.resolveMcpServers({
      aitmGlobal: global?.mcpServers,
      aitmProject: project?.mcpServers,
      claudeUser,
      claudeProject,
    });

    return {
      openrouterApiKey: apiKey,
      apiKeySource,
      models: this.resolveModels(global, project, cliOverrides),
      maxPrs: pick(cliOverrides.maxPrs, project?.maxPrs, global?.maxPrs, DEFAULTS.maxPrs),
      maxSessions: pickNullable(
        cliOverrides.maxSessions,
        project?.maxSessions,
        global?.maxSessions,
        DEFAULTS.maxSessions,
      ),
      autoMerge: pick(
        cliOverrides.autoMerge,
        project?.autoMerge,
        global?.autoMerge,
        DEFAULTS.autoMerge,
      ),
      mergeMethod: pick(
        cliOverrides.mergeMethod,
        project?.mergeMethod,
        global?.mergeMethod,
        DEFAULTS.mergeMethod,
      ),
      stylePath: pickNullable(
        cliOverrides.stylePath,
        project?.stylePath,
        global?.stylePath,
        DEFAULTS.stylePath,
      ),
      // logLevel is not exposed via CliOverrides — project/global only.
      logLevel: pick(undefined, project?.logLevel, global?.logLevel, DEFAULTS.logLevel),
      concurrency: pick(
        cliOverrides.concurrency,
        project?.concurrency,
        global?.concurrency,
        DEFAULTS.concurrency,
      ),
      mcpServers,
      mcpServerSources,
    };
  }

  async readGlobal(): Promise<ConfigFile | null> {
    return this.readConfigFile(join(this.homeDir, GLOBAL_FILE));
  }

  async readProject(): Promise<ConfigFile | null> {
    return this.readConfigFile(join(this.cwd, PROJECT_DIR, PROJECT_FILE));
  }

  // Read Claude Code's project-scoped MCP file (./.mcp.json). Schema is permissive:
  // we only extract `mcpServers`, ignore any other keys Claude Code may add.
  async readClaudeProjectMcp(): Promise<McpServers | null> {
    return this.readMcpEnvelope(join(this.cwd, CLAUDE_PROJECT_MCP_FILE));
  }

  // Read Claude Code's user-scoped config (~/.claude.json) and extract the `mcpServers`
  // block, if any. ~/.claude.json holds many unrelated keys (auth tokens, history); we
  // intentionally read it but only consume `mcpServers`.
  async readClaudeUserMcp(): Promise<McpServers | null> {
    return this.readMcpEnvelope(join(this.homeDir, CLAUDE_USER_FILE));
  }

  // Frozen run snapshot. API key value is replaced by its source label so the
  // file is safe to inspect; only the resolution source is recorded.
  async writeSnapshot(resolved: ResolvedConfig, stateDir: string): Promise<void> {
    const redacted: ResolvedConfig = {
      ...resolved,
      openrouterApiKey: `<from ${resolved.apiKeySource}>`,
    };
    const path = join(stateDir, SNAPSHOT_FILE);
    await atomicWrite(path, `${JSON.stringify(redacted, null, 2)}\n`);
  }

  // Reads any JSON file whose only field we care about is `mcpServers` (Claude Code's
  // .mcp.json or the much larger ~/.claude.json). Missing file → null. Malformed JSON
  // is a hard error — we don't want to silently ignore a corrupted user file.
  private async readMcpEnvelope(path: string): Promise<McpServers | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${path}: invalid JSON — ${msg}`);
    }
    const envelope = McpEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new Error(`${path}: ${formatZodError(envelope.error)}`);
    }
    return envelope.data.mcpServers ?? null;
  }

  private resolveMcpServers(sources: {
    aitmGlobal: McpServers | undefined;
    aitmProject: McpServers | undefined;
    claudeUser: McpServers | null;
    claudeProject: McpServers | null;
  }): { mcpServers: McpServers; mcpServerSources: Record<string, McpServerSource> } {
    // Precedence, lowest → highest:
    //   1. ~/.claude.json (user-scoped Claude Code config)
    //   2. ~/.aitm.json   (user-scoped aitm config)
    //   3. ./.mcp.json    (project-scoped Claude Code config, checked into git)
    //   4. ./.ai-task-master/config.json (project-scoped aitm config — final word)
    // Same name in two places: higher precedence wins; the lower is shadowed with a warn.
    const layers: Array<[McpServerSource, McpServers | null | undefined]> = [
      ['claude-user', sources.claudeUser],
      ['aitm-global', sources.aitmGlobal],
      ['claude-mcp-project', sources.claudeProject],
      ['aitm-project', sources.aitmProject],
    ];
    const merged: McpServers = {};
    const sourceMap: Record<string, McpServerSource> = {};
    for (const [label, servers] of layers) {
      if (!servers) continue;
      for (const [name, server] of Object.entries(servers)) {
        if (name in merged) {
          this.warn(`mcp server "${name}" from ${label} shadows entry from ${sourceMap[name]}`);
        }
        merged[name] = server;
        sourceMap[name] = label;
      }
    }
    return { mcpServers: merged, mcpServerSources: sourceMap };
  }

  private async readConfigFile(path: string): Promise<ConfigFile | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${path}: invalid JSON — ${msg}`);
    }
    let validated: ConfigFile;
    try {
      validated = ConfigFileSchema.parse(parsed);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new Error(`${path}: ${formatZodError(err)}`);
      }
      throw err;
    }
    for (const k of Object.keys(validated)) {
      if (!KNOWN_KEYS.has(k)) {
        this.warn(`${path}: unknown config key "${k}" — ignored`);
      }
    }
    return validated;
  }

  private resolveApiKey(
    global: ConfigFile | null,
    project: ConfigFile | null,
  ): { apiKey: string | undefined; apiKeySource: ResolvedConfig['apiKeySource'] | undefined } {
    if (project?.openrouterApiKey) {
      return { apiKey: project.openrouterApiKey, apiKeySource: 'project' };
    }
    if (global?.openrouterApiKey) {
      return { apiKey: global.openrouterApiKey, apiKeySource: 'global' };
    }
    const envKey = this.env.OPENROUTER_API_KEY;
    if (envKey) {
      return { apiKey: envKey, apiKeySource: 'env' };
    }
    return { apiKey: undefined, apiKeySource: undefined };
  }

  private resolveModels(
    global: ConfigFile | null,
    project: ConfigFile | null,
    cliOverrides: CliOverrides,
  ): ResolvedConfig['models'] {
    const merged: ResolvedConfig['models'] = {
      generic: DEFAULT_MODELS.generic,
      smart: DEFAULT_MODELS.smart,
      coding: DEFAULT_MODELS.coding,
      fast: DEFAULT_MODELS.fast,
    };
    for (const src of [global?.models, project?.models]) {
      if (!src) continue;
      if (src.generic) merged.generic = src.generic;
      if (src.smart) merged.smart = src.smart;
      if (src.coding) merged.coding = src.coding;
      if (src.fast) merged.fast = src.fast;
    }
    // --model pins the `generic` tier — the fallback every other capability
    // inherits when not explicitly set. See docs/config.md §"Per-role models".
    if (cliOverrides.model) merged.generic = cliOverrides.model;
    return merged;
  }
}

function pick<T>(
  cli: T | undefined,
  project: T | undefined,
  global: T | undefined,
  fallback: T,
): T {
  if (cli !== undefined) return cli;
  if (project !== undefined) return project;
  if (global !== undefined) return global;
  return fallback;
}

function pickNullable<T>(
  cli: T | null | undefined,
  project: T | null | undefined,
  global: T | null | undefined,
  fallback: T | null,
): T | null {
  if (cli !== undefined) return cli;
  if (project !== undefined) return project;
  if (global !== undefined) return global;
  return fallback;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function formatZodError(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

// Permissive envelope for Claude Code config files: we only extract `mcpServers` and
// ignore every other key (~/.claude.json especially has many auth/history fields).
const McpEnvelopeSchema = z
  .object({
    mcpServers: McpServersSchema.optional(),
  })
  .passthrough();

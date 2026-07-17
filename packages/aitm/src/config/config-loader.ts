// docs/config.md §"Resolution order", docs/auth.md §"LLM provider"
// Only module allowed to read ~/.aitm.json and .ai-task-master/config.json.
// Run settings merge low→high: defaults < global < project < CLI flags.
// Provider credentials (openrouterApiKey, baseURL) are USER-OWNED ONLY: they resolve
// global > profile > env — user config wins, env is the fallback — and are stripped from project
// scope, so an untrusted repo can neither redirect inference nor swap the key (see
// stripUntrustedProjectFields). A stdio MCP server (spawns a local process) is likewise honored
// ONLY from user-owned config; a project-scoped stdio entry is dropped + warned (see
// resolveMcpServers) so an untrusted repo can't run arbitrary commands. HTTP/SSE MCP servers (a URL,
// no spawn) are allowed from any scope. Frozen snapshot written by writeSnapshot().

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRule } from '@developerz.ai/ai-claude-compat';
import { ZodError, z } from 'zod';
import { DEFAULT_MODELS } from '../credentials/defaults.ts';
import { atomicWrite } from '../fs/atomic-write.ts';
import { DEFAULT_MAX_CI_FIX_ATTEMPTS } from '../loop/constants.ts';
import { DEFAULT_MCP_DEFER_TOOLS_OVER } from '../mcp/mcp-client.ts';
import { type McpServer, type McpServers, McpServersSchema } from '../mcp/schema.ts';
import { DEFAULT_LLM_STEP_TIMEOUT_MS } from '../subagents/factory.ts';
import {
  type CliOverrides,
  type ConfigFile,
  ConfigFileSchema,
  type McpServerSource,
  type Profile,
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
  'activeProfile',
  'profiles',
  'baseURL',
  'models',
  'maxPrs',
  'maxSessions',
  'maxCiFixAttempts',
  'llmStepTimeoutMs',
  'autoMerge',
  'webSearch',
  'mergeMethod',
  'stylePath',
  'formatCommand',
  'verifyCommand',
  'selfReview',
  'resolveConflicts',
  'logLevel',
  'concurrency',
  'bashRules',
  'providerRouting',
  'fallbackModels',
  'reasoningEffort',
  'mcpServers',
  'mcpRoleAllowlist',
  'mcpDeferToolsOver',
  'hooks',
]);

// Fields a project-scoped .ai-task-master/config.json must NEVER control — an autonomous run points
// at untrusted repos, so honoring these would let a checked-in file steer the harness. Honored ONLY
// from the user-owned global config (~/.aitm.json); a project config that sets them is warned +
// stripped by stripUntrustedProjectFields, the single project-scope trust strip point:
//   - baseURL           redirects inference to an arbitrary host, which also receives the Bearer key
//   - openrouterApiKey  swaps the provider credential
//   - hooks             run shell commands with the operator's privileges (issue #121 CR)
const UNTRUSTED_PROJECT_FIELDS = [
  {
    key: 'baseURL',
    reason: 'a project-set base URL could redirect inference and leak the API key',
  },
  { key: 'openrouterApiKey', reason: 'an API key is a provider credential' },
  { key: 'hooks', reason: 'hooks run shell commands' },
] as const satisfies ReadonlyArray<{ key: keyof ConfigFile; reason: string }>;

// Built-in destructive-command deny rules, appended AFTER any configured rules so a repo can
// allow-override a single default (first-match-wins) without losing the rest (issue #113).
// `git push --force*` deliberately also catches `--force-with-lease` on the model-facing side — the
// sanctioned lease push is the harness's own CI-fix flow, not the model's shell.
export const DEFAULT_BASH_RULES: readonly CommandRule[] = [
  { pattern: 'git push --force*', action: 'deny' },
  { pattern: 'git push -f', action: 'deny' },
  { pattern: 'git push +*', action: 'deny' },
  { pattern: 'gh pr merge', action: 'deny' },
  { pattern: 'git reset --hard', action: 'deny' },
];

const DEFAULTS = {
  maxPrs: 5,
  maxSessions: null as number | null,
  maxCiFixAttempts: DEFAULT_MAX_CI_FIX_ATTEMPTS,
  llmStepTimeoutMs: DEFAULT_LLM_STEP_TIMEOUT_MS,
  autoMerge: true,
  prPerTask: false,
  mergeMethod: 'squash' as const,
  adminMerge: false,
  stylePath: null as string | null,
  formatCommand: null as string | null,
  verifyCommand: null as string | null,
  // Self-review is default-ON: every PR is adversarially reviewed + verified before it opens.
  selfReview: true,
  // AI conflict resolution is default-ON: a rebase/merge conflict is handed to a subagent before
  // the group blocks for a human.
  resolveConflicts: true,
  logLevel: 'info' as const,
  concurrency: 1,
  allowForcePush: true,
  mcpDeferToolsOver: DEFAULT_MCP_DEFER_TOOLS_OVER,
};

type WarnFn = (msg: string) => void;

export type ConfigLoaderOptions = {
  warn?: WarnFn;
};

export class ConfigLoader {
  private readonly warn: WarnFn;
  // stripUntrustedProjectFields warns at most once per ignored project field for this loader
  // instance, so a repeat resolve() doesn't re-emit the same warning.
  private readonly warnedUntrustedProjectFields = new Set<string>();
  // resolveMcpServers warns at most once per blocked project-scoped stdio server name, same as above.
  private readonly warnedBlockedProjectStdioMcp = new Set<string>();

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
    const project = this.stripUntrustedProjectFields(await this.readProject());
    const claudeUser = await this.readClaudeUserMcp();
    const claudeProject = await this.readClaudeProjectMcp();

    // The active provider profile (global-only) supplies provider defaults that sit between
    // explicit top-level config and env — see resolveApiKey/resolveBaseURL/resolveModels.
    const active = this.resolveActiveProfile(global);
    const profile = active?.profile;

    const { apiKey, apiKeySource } = this.resolveApiKey(global, profile);

    if (apiKey === undefined || apiKeySource === undefined) {
      throw new Error(
        'No OpenRouter API key found. Set OPENROUTER_API_KEY env, add ' +
          '"openrouterApiKey" to the user-owned ~/.aitm.json (a project config.json is ignored ' +
          'for credentials), or create a profile with `aitm profile add <name> --api-key <key>`.',
      );
    }

    const { mcpServers, mcpServerSources } = this.resolveMcpServers({
      aitmGlobal: global?.mcpServers,
      aitmProject: project?.mcpServers,
      claudeUser,
      claudeProject,
    });

    // Optional per-repo PR body sections (project > global). Undefined when neither sets it.
    const prBodySections = project?.prBodySections ?? global?.prBodySections;

    // Configured bash rules (project over global, wholesale) then the built-in defaults, so every
    // consumer sees one final first-match-wins list (issue #113).
    const bashRules: readonly CommandRule[] = [
      ...(project?.bashRules ?? global?.bashRules ?? []),
      ...DEFAULT_BASH_RULES,
    ];

    // Provider routing + fallback models — provider-shaped, resolved project > global > profile.
    // Undefined when no layer sets it (issue #124).
    const providerRouting =
      project?.providerRouting ?? global?.providerRouting ?? profile?.providerRouting;
    const fallbackModels =
      project?.fallbackModels ?? global?.fallbackModels ?? profile?.fallbackModels;

    return {
      openrouterApiKey: apiKey,
      apiKeySource,
      ...(active ? { activeProfile: active.name } : {}),
      baseURL: this.resolveBaseURL(global, profile),
      models: this.resolveModels(global, project, profile, cliOverrides),
      maxPrs: pick(cliOverrides.maxPrs, project?.maxPrs, global?.maxPrs, DEFAULTS.maxPrs),
      maxSessions: pickNullable(
        cliOverrides.maxSessions,
        project?.maxSessions,
        global?.maxSessions,
        DEFAULTS.maxSessions,
      ),
      maxCiFixAttempts: pick(
        cliOverrides.maxCiFixAttempts,
        project?.maxCiFixAttempts,
        global?.maxCiFixAttempts,
        DEFAULTS.maxCiFixAttempts,
      ),
      // Config-only (no CLI flag): project > global > default.
      llmStepTimeoutMs: pick(
        undefined,
        project?.llmStepTimeoutMs,
        global?.llmStepTimeoutMs,
        DEFAULTS.llmStepTimeoutMs,
      ),
      autoMerge: pick(
        cliOverrides.autoMerge,
        project?.autoMerge,
        global?.autoMerge,
        DEFAULTS.autoMerge,
      ),
      prPerTask: pick(cliOverrides.prPerTask, undefined, undefined, DEFAULTS.prPerTask),
      mergeMethod: pick(
        cliOverrides.mergeMethod,
        project?.mergeMethod,
        global?.mergeMethod,
        DEFAULTS.mergeMethod,
      ),
      // CLI-only (per run): not read from config files, so no project/global layer.
      adminMerge: pick(cliOverrides.adminMerge, undefined, undefined, DEFAULTS.adminMerge),
      stylePath: pickNullable(
        cliOverrides.stylePath,
        project?.stylePath,
        global?.stylePath,
        DEFAULTS.stylePath,
      ),
      // formatCommand is not exposed via CliOverrides — project/global only.
      formatCommand: pickNullable(
        undefined,
        project?.formatCommand,
        global?.formatCommand,
        DEFAULTS.formatCommand,
      ),
      // verifyCommand is not exposed via CliOverrides — project/global only, like formatCommand.
      verifyCommand: pickNullable(
        undefined,
        project?.verifyCommand,
        global?.verifyCommand,
        DEFAULTS.verifyCommand,
      ),
      // selfReview defaults ON (project > global). No CLI flag: it is a safety gate, toggled per repo.
      selfReview: pick(undefined, project?.selfReview, global?.selfReview, DEFAULTS.selfReview),
      // resolveConflicts defaults ON (project > global). No CLI flag — a per-repo capability toggle.
      resolveConflicts: pick(
        undefined,
        project?.resolveConflicts,
        global?.resolveConflicts,
        DEFAULTS.resolveConflicts,
      ),
      // logLevel is not exposed via CliOverrides — project/global only.
      logLevel: pick(undefined, project?.logLevel, global?.logLevel, DEFAULTS.logLevel),
      concurrency: pick(
        cliOverrides.concurrency,
        project?.concurrency,
        global?.concurrency,
        DEFAULTS.concurrency,
      ),
      // allowForcePush is not exposed via CliOverrides — project/global only.
      allowForcePush: pick(
        undefined,
        project?.allowForcePush,
        global?.allowForcePush,
        DEFAULTS.allowForcePush,
      ),
      // Tri-state (project > global), left undefined when unset so the adapter can tell "CI-fix only"
      // (undefined) apart from "never" (false). No CLI flag, no default collapse. Issue #112.
      ...((project?.webSearch ?? global?.webSearch) !== undefined
        ? { webSearch: project?.webSearch ?? global?.webSearch }
        : {}),
      ...(prBodySections !== undefined ? { prBodySections } : {}),
      ...(providerRouting !== undefined ? { providerRouting } : {}),
      ...(fallbackModels !== undefined ? { fallbackModels } : {}),
      reasoningEffort: this.resolveReasoningEffort(global, project, profile),
      bashRules,
      // Per-role MCP allowlist — aitm config only, project over global (issue #115). Omitted when
      // neither sets it, so every role gets every connected server.
      ...((project?.mcpRoleAllowlist ?? global?.mcpRoleAllowlist)
        ? { mcpRoleAllowlist: project?.mcpRoleAllowlist ?? global?.mcpRoleAllowlist }
        : {}),
      // Defer-tools threshold — aitm config only, project over global (issue #119). pick() treats a
      // configured 0 as set (!== undefined), so "always defer" survives the default.
      mcpDeferToolsOver: pick(
        undefined,
        project?.mcpDeferToolsOver,
        global?.mcpDeferToolsOver,
        DEFAULTS.mcpDeferToolsOver,
      ),
      // Tool-registry hooks (issue #121). Hooks run shell commands with the operator's privileges, so
      // they are honored ONLY from the user-owned global config (~/.aitm.json) — NEVER from the
      // per-repo project config, which an untrusted repo could ship (CR: arbitrary code execution). A
      // project that sets `hooks` is warned + stripped (see stripUntrustedProjectFields).
      ...(global?.hooks ? { hooks: global.hooks } : {}),
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

  // The top-level project-scope trust boundary: drop every UNTRUSTED_PROJECT_FIELDS entry a project
  // config.json set (provider credentials + shell hooks) so nothing downstream — resolveApiKey,
  // resolveBaseURL, the resolved hooks, the snapshot — can honor attacker-controlled input. Returns
  // a sanitized copy (the input is left untouched); warns at most once per field per loader instance.
  // The sibling gate for per-server MCP transport (project-scope stdio is code execution) lives in
  // resolveMcpServers, which also sees the two project-scoped Claude Code files.
  private stripUntrustedProjectFields(project: ConfigFile | null): ConfigFile | null {
    if (!project) return project;
    const sanitized: ConfigFile = { ...project };
    for (const { key, reason } of UNTRUSTED_PROJECT_FIELDS) {
      if (sanitized[key] === undefined) continue;
      this.warnUntrustedProjectField(key, reason);
      delete sanitized[key];
    }
    return sanitized;
  }

  private warnUntrustedProjectField(key: string, reason: string): void {
    if (this.warnedUntrustedProjectFields.has(key)) return;
    this.warnedUntrustedProjectFields.add(key);
    this.warn(
      `${key} in ./${PROJECT_DIR}/${PROJECT_FILE} is ignored — ${reason}; honored only from the user-owned ~/${GLOBAL_FILE}`,
    );
  }

  // A stdio MCP server declared in project scope (./.mcp.json or ./.ai-task-master/config.json) is
  // dropped as a code-execution trust boundary — see resolveMcpServers. Warns at most once per
  // server name per loader instance.
  private warnBlockedProjectStdioMcp(name: string, source: McpServerSource): void {
    if (this.warnedBlockedProjectStdioMcp.has(name)) return;
    this.warnedBlockedProjectStdioMcp.add(name);
    this.warn(
      `mcp server "${name}" from ${source} is ignored — a project-scoped stdio server spawns a ` +
        'local process from repo-controlled command/args/env; declare it in the user-owned ' +
        `~/${GLOBAL_FILE} to run it, or use an http/sse server`,
    );
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
        // Trust boundary: a stdio server spawns a local process from its command/args/env. From a
        // project-scoped source (a file an untrusted repo ships) that is arbitrary code execution, so
        // it is dropped + warned — a stdio server is honored only from user-owned config. HTTP/SSE
        // servers (a URL, no spawn) are allowed from any scope. Same trust point as
        // stripUntrustedProjectFields, extended to per-server MCP transport.
        if (isProjectScopedSource(label) && isStdioServer(server)) {
          this.warnBlockedProjectStdioMcp(name, label);
          continue;
        }
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

  // Resolve the active provider profile (global-only). Returns undefined when no profile is
  // active. A dangling `activeProfile` (set but no matching profile) warns and falls through
  // to the no-profile path rather than throwing — the run still works off top-level/env.
  private resolveActiveProfile(
    global: ConfigFile | null,
  ): { name: string; profile: Profile } | undefined {
    const name = global?.activeProfile;
    if (!name) return undefined;
    const profile = global?.profiles?.[name];
    if (!profile) {
      this.warn(
        `activeProfile "${name}" is set in ~/.aitm.json but no such profile exists — ignoring it. ` +
          'Run `aitm profile list` to see available profiles.',
      );
      return undefined;
    }
    return { name, profile };
  }

  // Precedence: global > active profile > env OPENROUTER_BASE_URL — user config wins, env is the
  // fallback. Project scope is NEVER consulted: a project-set baseURL is stripped upstream
  // (stripUntrustedProjectFields) so an untrusted repo can't redirect inference or leak the key.
  // Undefined → provider default. Config-file values are already URL-validated by ConfigFileSchema;
  // the env value is validated here so every source honors the same "validated as a URL" contract
  // (docs/auth.md §"Base URL"). A whitespace-only / empty env var means "no override".
  private resolveBaseURL(
    global: ConfigFile | null,
    profile: Profile | undefined,
  ): string | undefined {
    if (global?.baseURL) return global.baseURL;
    if (profile?.baseURL) return profile.baseURL;
    const env = this.env.OPENROUTER_BASE_URL?.trim();
    if (!env) return undefined;
    const parsed = z.url().safeParse(env);
    if (!parsed.success) {
      throw new Error(`OPENROUTER_BASE_URL is not a valid URL: ${JSON.stringify(env)}`);
    }
    return parsed.data;
  }

  // Precedence: global > active profile > env — user config wins, env is the fallback. Project
  // scope is NEVER consulted: a project-set openrouterApiKey is stripped upstream
  // (stripUntrustedProjectFields), so an untrusted repo can't swap the provider credential. The
  // profile sits below explicit top-level global config (so a legacy flat key still wins) but above
  // env (so `aitm profile use` takes effect even when a stale OPENROUTER_API_KEY lingers).
  private resolveApiKey(
    global: ConfigFile | null,
    profile: Profile | undefined,
  ): { apiKey: string | undefined; apiKeySource: ResolvedConfig['apiKeySource'] | undefined } {
    if (global?.openrouterApiKey) {
      return { apiKey: global.openrouterApiKey, apiKeySource: 'global' };
    }
    if (profile?.openrouterApiKey) {
      return { apiKey: profile.openrouterApiKey, apiKeySource: 'profile' };
    }
    const envKey = this.env.OPENROUTER_API_KEY;
    if (envKey) {
      return { apiKey: envKey, apiKeySource: 'env' };
    }
    return { apiKey: undefined, apiKeySource: undefined };
  }

  // Layer order (lowest → highest): defaults < active profile < global < project < CLI.
  // The profile fills tiers it specifies; explicit config still overrides per tier.
  private resolveModels(
    global: ConfigFile | null,
    project: ConfigFile | null,
    profile: Profile | undefined,
    cliOverrides: CliOverrides,
  ): ResolvedConfig['models'] {
    const merged: ResolvedConfig['models'] = {
      generic: DEFAULT_MODELS.generic,
      smart: DEFAULT_MODELS.smart,
      coding: DEFAULT_MODELS.coding,
      fast: DEFAULT_MODELS.fast,
    };
    for (const src of [profile?.models, global?.models, project?.models]) {
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

  // Per-capability reasoning effort, merged profile < global < project (issue #125). No CLI
  // override and no built-in defaults — starts empty, so an unconfigured capability carries no
  // effort and its request stays byte-identical. `generic` is a plain capability here, NOT a
  // fallback for the other tiers (unlike resolveModels' generic).
  private resolveReasoningEffort(
    global: ConfigFile | null,
    project: ConfigFile | null,
    profile: Profile | undefined,
  ): ResolvedConfig['reasoningEffort'] {
    const merged: ResolvedConfig['reasoningEffort'] = {};
    for (const src of [
      profile?.reasoningEffort,
      global?.reasoningEffort,
      project?.reasoningEffort,
    ]) {
      if (!src) continue;
      if (src.generic) merged.generic = src.generic;
      if (src.smart) merged.smart = src.smart;
      if (src.coding) merged.coding = src.coding;
      if (src.fast) merged.fast = src.fast;
    }
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

// The two project-scoped MCP sources — files an untrusted repo can ship (./.mcp.json and
// ./.ai-task-master/config.json). aitm-global and claude-user are user-owned, hence trusted.
function isProjectScopedSource(source: McpServerSource): boolean {
  return source === 'aitm-project' || source === 'claude-mcp-project';
}

// A stdio server spawns a local process; http/sse carry a `url` and only open a socket. Mirrors
// transportKind in ../mcp/mcp-client.ts — kept in sync with McpServerSchema in ../mcp/schema.ts.
function isStdioServer(server: McpServer): boolean {
  return !('url' in server);
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

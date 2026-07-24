// docs/config.md §"Resolution order", docs/auth.md §"LLM provider"
// Only module allowed to read ~/.aitm.json and .ai-task-master/config.json.
// Run settings merge low→high: defaults < global < project < env < CLI flags. `env` here is the
// bounded AITM_* set resolveEnvOverrides() reads (maxPrs/maxSessions/maxCiFixAttempts/concurrency/
// autoMerge/prPerTask/selfReview/mergeMethod/logLevel) — CI wrappers that can't/won't write
// .ai-task-master/config.json tune these without one. Everything else stays project/global-only.
// Provider credentials (openrouterApiKey, baseURL) are USER-OWNED ONLY: they resolve
// global > profile > env — user config wins, env is the fallback — and are stripped from project
// scope, so an untrusted repo can neither redirect inference nor swap the key (see
// stripUntrustedProjectFields). Bash governance (bashRules) is tighten-only from project scope: a
// repo may add denies but never an `allow`. MCP servers are the deliberate exception: a project-scoped stdio
// entry (./.mcp.json or ./.ai-task-master/config.json) IS honored and spawned, because plugging aitm
// into the same servers the repo's Claude Code session already uses is the point of discovering
// those files at all. Frozen snapshot written by writeSnapshot().

import { join } from 'node:path';
import type { CommandRule } from '@developerz.ai/ai-claude-compat';
import { ZodError, z } from 'zod';
import { DEFAULT_MODELS } from '../credentials/defaults.ts';
import { atomicWrite } from '../fs/atomic-write.ts';
import { registerSecretValues } from '../logger/secret-registry.ts';
import { DEFAULT_MAX_CI_FIX_ATTEMPTS } from '../loop/constants.ts';
import { DEFAULT_MCP_DEFER_TOOLS_OVER } from '../mcp/mcp-client.ts';
import { type McpServers, McpServersSchema } from '../mcp/schema.ts';
import { DEFAULT_LLM_STEP_TIMEOUT_MS } from '../subagents/factory.ts';
import { formatZodError, readJsonFile } from './json-file.ts';
import {
  type Capability,
  type CliOverrides,
  CONFIG_KEYS,
  type ConfigFile,
  ConfigFileSchema,
  type ConfigSource,
  type ConfigSourceMap,
  LogLevelSchema,
  type McpServerSource,
  MergeMethodSchema,
  type Profile,
  type ResolvedConfig,
} from './schema.ts';

// The env-overridable subset of run settings, one field per AITM_* var resolveEnvOverrides()
// reads. `undefined` per field means "that var was unset/blank" — see the individual parse
// helpers below.
type EnvOverrides = {
  maxPrs: number | undefined;
  maxSessions: number | null | undefined;
  maxCiFixAttempts: number | undefined;
  concurrency: number | undefined;
  autoMerge: boolean | undefined;
  prPerTask: boolean | undefined;
  selfReview: boolean | undefined;
  mergeMethod: ResolvedConfig['mergeMethod'] | undefined;
  logLevel: ResolvedConfig['logLevel'] | undefined;
};

// A positive integer env var (maxPrs, maxCiFixAttempts, concurrency). Blank/unset → no override;
// anything else that doesn't parse as one throws, matching resolveBaseURL's "validate the env
// value the same way the config-file value is validated" convention.
function parseEnvInt(name: string, raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = z.coerce.number().int().positive().safeParse(trimmed);
  if (!parsed.success) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed.data;
}

// maxSessions is the one int-typed override that is also nullable: 0 means "unlimited" (null),
// mirroring toCliOverrides's --max-sessions 0 → null mapping in cli/commands.ts.
function parseEnvMaxSessions(raw: string | undefined): number | null | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = z.coerce.number().int().nonnegative().safeParse(trimmed);
  if (!parsed.success) {
    throw new Error(`AITM_MAX_SESSIONS must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed.data === 0 ? null : parsed.data;
}

function parseEnvBool(name: string, raw: string | undefined): boolean | undefined {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === 'false' || trimmed === '0') return false;
  throw new Error(`${name} must be "true"/"false" (or "1"/"0"), got ${JSON.stringify(raw)}`);
}

function parseEnvMergeMethod(raw: string | undefined): ResolvedConfig['mergeMethod'] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = MergeMethodSchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new Error(
      `AITM_MERGE_METHOD must be one of ${MergeMethodSchema.options.join(', ')}, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

function parseEnvLogLevel(raw: string | undefined): ResolvedConfig['logLevel'] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = LogLevelSchema.safeParse(trimmed);
  if (!parsed.success) {
    throw new Error(
      `AITM_LOG_LEVEL must be one of ${LogLevelSchema.options.join(', ')}, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed.data;
}

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

// Fields a project-scoped .ai-task-master/config.json must NEVER control — an autonomous run points
// at untrusted repos, so honoring these would let a checked-in file steer the harness. Honored ONLY
// from the user-owned global config (~/.aitm.json); a project config that sets them is warned +
// stripped by stripUntrustedProjectFields, the single project-scope trust strip point:
//   - baseURL           redirects inference to an arbitrary host, which also receives the Bearer key
//   - openrouterApiKey  swaps the provider credential
//   - hooks             run shell commands with the operator's privileges (issue #121 CR)
//   - formatCommand     runs via `sh -c` in the Worker's format gate (issue #214)
//   - verifyCommand     runs via `sh -c` in the verify gate and self-review (issue #214)
//   - stylePath         reads an arbitrary absolute path into subagent prompts (issue #214);
//                       in-repo style is served by CLAUDE.md/AGENTS.md auto-detection instead
// `bashRules` is the one partially-trusted field: project scope may only TIGHTEN it, so its `allow`
// entries are dropped and its denies merged rather than the whole field being stripped —
// see stripProjectBashAllowRules.
export const UNTRUSTED_PROJECT_FIELDS = [
  {
    key: 'baseURL',
    reason: 'a project-set base URL could redirect inference and leak the API key',
  },
  { key: 'openrouterApiKey', reason: 'an API key is a provider credential' },
  { key: 'hooks', reason: 'hooks run shell commands' },
  { key: 'formatCommand', reason: 'formatCommand runs shell commands' },
  { key: 'verifyCommand', reason: 'verifyCommand runs shell commands' },
  { key: 'stylePath', reason: 'a project-set style path can read files outside the repo' },
] as const satisfies ReadonlyArray<{ key: keyof ConfigFile; reason: string }>;

// Built-in destructive-command deny rules, appended AFTER any configured rules so the OPERATOR can
// allow-override a single default from ~/.aitm.json (first-match-wins) without losing the rest
// (issue #113). A project config cannot: its `allow` entries are dropped upstream.
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
  allowDirty: false,
  stylePath: null as string | null,
  formatCommand: null as string | null,
  verifyCommand: null as string | null,
  // Self-review is default-ON: every PR is adversarially reviewed + verified before it opens.
  selfReview: true,
  // AI conflict resolution is default-ON: a rebase/merge conflict is handed to a subagent before
  // the group blocks for a human.
  resolveConflicts: true,
  // Specialist bootstrap is default-ON: a repo with no .claude/agents gets a generated team.
  generateSpecialists: true,
  logLevel: 'info' as const,
  concurrency: 1,
  editorConcurrency: 4,
  allowForcePush: true,
  mcpDeferToolsOver: DEFAULT_MCP_DEFER_TOOLS_OVER,
  // Streaming is default-OFF (slice 07): gated behind config until burn-in.
  streaming: false,
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

  constructor(
    private readonly cwd: string,
    private readonly homeDir: string,
    private readonly env: Record<string, string | undefined>,
    options?: ConfigLoaderOptions,
  ) {
    this.warn = options?.warn ?? ((msg) => process.stderr.write(`${msg}\n`));
  }

  async resolve(cliOverrides: CliOverrides): Promise<ResolvedConfig> {
    return (await this.resolveWithSources(cliOverrides)).resolved;
  }

  // Like resolve(), but also returns a per-key provenance map (which layer supplied each resolved
  // value). The values come from the SAME pick calls resolve() uses — resolve() is now a thin
  // projection of this method — so a label can never drift from the value it names. Surfaced by
  // `aitm config list --effective`. bashRules (a first-match-wins merge) and mcpServers (its own
  // McpServerSource per entry) carry their provenance in the resolved value itself, not in `sources`.
  async resolveWithSources(
    cliOverrides: CliOverrides,
  ): Promise<{ resolved: ResolvedConfig; sources: ConfigSourceMap }> {
    const sources: ConfigSourceMap = {};
    // Every layer below reads the same cli/env/project/global arguments in the same order as
    // pick()/pickNullable(), so a source label can never drift from the value it names. `env` is
    // undefined for keys with no env override (docs/config.md §"Resolution order": cli > env >
    // project > global > default) — see resolveEnvOverrides.
    const track = <T>(
      key: string,
      cli: T | undefined,
      env: T | undefined,
      project: T | undefined,
      global: T | undefined,
      fallback: T,
    ): T => {
      sources[key] = layerOf(cli, env, project, global);
      return pick(cli, env, project, global, fallback);
    };
    const trackNullable = <T>(
      key: string,
      cli: T | null | undefined,
      env: T | null | undefined,
      project: T | null | undefined,
      global: T | null | undefined,
      fallback: T | null,
    ): T | null => {
      sources[key] = layerOf(cli, env, project, global);
      return pickNullable(cli, env, project, global, fallback);
    };
    // CI wrappers that can't/won't write a config file still need to set the run settings they
    // most commonly tune — bounded to the keys below (issue: findings/03-cli-config.md). Anything
    // not listed here has no env override; pass `undefined` at its track() call site.
    const envOverrides = this.resolveEnvOverrides();

    const global = await this.readGlobal();
    this.registerProviderSecrets(global);
    const project = this.stripUntrustedProjectFields(await this.readProject());
    const claudeUser = await this.readClaudeUserMcp();
    const claudeProject = await this.readClaudeProjectMcp();

    // The active provider profile (global-only) supplies provider defaults that sit between
    // explicit top-level config and env — see resolveApiKey/resolveBaseURL/resolveModels.
    const active = this.resolveActiveProfile(global);
    const profile = active?.profile;

    const { baseURL, baseURLSource } = this.resolveBaseURL(global, profile, active?.name);
    const { apiKey, apiKeySource } = this.resolveApiKey(global, profile, baseURLSource);

    if (apiKey === undefined || apiKeySource === undefined) {
      throw new Error(
        baseURLSource === 'profile'
          ? `Active profile "${active?.name}" sets a baseURL (${baseURL}) but no API key of its own, ` +
              'and any top-level openrouterApiKey belongs to a different provider (it would be rejected ' +
              `by that endpoint). Set the profile's key: \`aitm profile set ${active?.name} openrouterApiKey <key>\`.`
          : 'No OpenRouter API key found. Set OPENROUTER_API_KEY env, add ' +
              '"openrouterApiKey" to the user-owned ~/.aitm.json (a project config.json is ignored ' +
              'for credentials), or create a profile with `aitm profile add <name> --api-key <key>`.',
      );
    }

    // apiKeySource is defined past the throw above; baseURLSource is undefined only when no override
    // was set, i.e. the provider default. Profiles are a global-only feature, so an active one is
    // sourced from the global file.
    sources.openrouterApiKey = apiKeySource;
    sources.baseURL = baseURLSource ?? 'default';
    if (active) sources.activeProfile = 'global';

    // Per-tier provenance for the composite provider maps (each tier can win from a different layer).
    const models = this.resolveModels(global, project, profile, cliOverrides);
    for (const [tier, src] of Object.entries(models.sources)) sources[`models.${tier}`] = src;
    const reasoningEffort = this.resolveReasoningEffort(global, project, profile);
    for (const [tier, src] of Object.entries(reasoningEffort.sources)) {
      sources[`reasoningEffort.${tier}`] = src;
    }

    const { mcpServers, mcpServerSources } = this.resolveMcpServers({
      aitmGlobal: global?.mcpServers,
      aitmProject: project?.mcpServers,
      claudeUser,
      claudeProject,
    });

    // Optional per-repo PR body sections (project > global). Undefined when neither sets it.
    const prBodySections = project?.prBodySections ?? global?.prBodySections;

    // Bash governance is tighten-only from project scope: the project's denies (its `allow` entries
    // were dropped upstream by stripProjectBashAllowRules) come first, then the user-owned global
    // rules — merged, NOT replaced, since wholesale replacement would let a repo drop the operator's
    // denies — then the built-in defaults. One final first-match-wins list per consumer (issue #113).
    const bashRules: readonly CommandRule[] = [
      ...(project?.bashRules ?? []),
      ...(global?.bashRules ?? []),
      ...DEFAULT_BASH_RULES,
    ];

    // Provider routing + fallback models — provider-shaped, resolved project > global > profile.
    // Undefined when no layer sets it (issue #124).
    const providerRouting =
      project?.providerRouting ?? global?.providerRouting ?? profile?.providerRouting;
    const fallbackModels =
      project?.fallbackModels ?? global?.fallbackModels ?? profile?.fallbackModels;

    const resolved: ResolvedConfig = {
      openrouterApiKey: apiKey,
      apiKeySource,
      ...(active ? { activeProfile: active.name } : {}),
      baseURL,
      models: models.value,
      maxPrs: track(
        'maxPrs',
        cliOverrides.maxPrs,
        envOverrides.maxPrs,
        project?.maxPrs,
        global?.maxPrs,
        DEFAULTS.maxPrs,
      ),
      maxSessions: trackNullable(
        'maxSessions',
        cliOverrides.maxSessions,
        envOverrides.maxSessions,
        project?.maxSessions,
        global?.maxSessions,
        DEFAULTS.maxSessions,
      ),
      maxCiFixAttempts: track(
        'maxCiFixAttempts',
        cliOverrides.maxCiFixAttempts,
        envOverrides.maxCiFixAttempts,
        project?.maxCiFixAttempts,
        global?.maxCiFixAttempts,
        DEFAULTS.maxCiFixAttempts,
      ),
      // Config-only (no CLI flag, no env override): project > global > default.
      llmStepTimeoutMs: track(
        'llmStepTimeoutMs',
        undefined,
        undefined,
        project?.llmStepTimeoutMs,
        global?.llmStepTimeoutMs,
        DEFAULTS.llmStepTimeoutMs,
      ),
      autoMerge: track(
        'autoMerge',
        cliOverrides.autoMerge,
        envOverrides.autoMerge,
        project?.autoMerge,
        global?.autoMerge,
        DEFAULTS.autoMerge,
      ),
      prPerTask: track(
        'prPerTask',
        cliOverrides.prPerTask,
        envOverrides.prPerTask,
        undefined,
        undefined,
        DEFAULTS.prPerTask,
      ),
      mergeMethod: track(
        'mergeMethod',
        cliOverrides.mergeMethod,
        envOverrides.mergeMethod,
        project?.mergeMethod,
        global?.mergeMethod,
        DEFAULTS.mergeMethod,
      ),
      // CLI-only (per run): not read from config files, so no project/global layer. No env
      // override — force-merging past branch protection should stay an explicit, per-invocation
      // decision, not something a stray environment variable can flip.
      adminMerge: track(
        'adminMerge',
        cliOverrides.adminMerge,
        undefined,
        undefined,
        undefined,
        DEFAULTS.adminMerge,
      ),
      // CLI-only for a stronger reason than adminMerge: a checked-in project config that could set
      // this would let an untrusted repo authorize wiping the operator's uncommitted work. Same
      // reasoning keeps it off the env-override list.
      allowDirty: track(
        'allowDirty',
        cliOverrides.allowDirty,
        undefined,
        undefined,
        undefined,
        DEFAULTS.allowDirty,
      ),
      // stylePath is honored from CLI/global only — a project-set value can point at an absolute
      // path outside the repo, and AgentConfigDetector's containment check covers relative paths
      // only. Warned + stripped from project scope (see stripUntrustedProjectFields, issue #214).
      stylePath: trackNullable(
        'stylePath',
        cliOverrides.stylePath,
        undefined,
        undefined,
        global?.stylePath,
        DEFAULTS.stylePath,
      ),
      // formatCommand/verifyCommand run via `sh -c` with the operator's privileges, so like hooks
      // they are honored ONLY from the user-owned global config — NEVER from project scope, which
      // an untrusted repo ships. Warned + stripped (see stripUntrustedProjectFields, issue #214).
      formatCommand: trackNullable(
        'formatCommand',
        undefined,
        undefined,
        undefined,
        global?.formatCommand,
        DEFAULTS.formatCommand,
      ),
      verifyCommand: trackNullable(
        'verifyCommand',
        undefined,
        undefined,
        undefined,
        global?.verifyCommand,
        DEFAULTS.verifyCommand,
      ),
      // selfReview defaults ON (project > global). No CLI flag, but env-overridable: it is a
      // safety/cost knob CI wrappers commonly want to toggle without a config file.
      selfReview: track(
        'selfReview',
        undefined,
        envOverrides.selfReview,
        project?.selfReview,
        global?.selfReview,
        DEFAULTS.selfReview,
      ),
      // resolveConflicts defaults ON (project > global). No CLI flag, no env override — a per-repo
      // capability toggle, not a per-run one.
      resolveConflicts: track(
        'resolveConflicts',
        undefined,
        undefined,
        project?.resolveConflicts,
        global?.resolveConflicts,
        DEFAULTS.resolveConflicts,
      ),
      // generateSpecialists defaults ON (project > global). No CLI flag, no env override — a
      // per-repo toggle, not a per-run one.
      generateSpecialists: track(
        'generateSpecialists',
        undefined,
        undefined,
        project?.generateSpecialists,
        global?.generateSpecialists,
        DEFAULTS.generateSpecialists,
      ),
      // logLevel is not exposed via CliOverrides, but is env-overridable — the canonical "CI
      // wrapper needs this without writing a file" case (findings/03-cli-config.md).
      logLevel: track(
        'logLevel',
        undefined,
        envOverrides.logLevel,
        project?.logLevel,
        global?.logLevel,
        DEFAULTS.logLevel,
      ),
      concurrency: track(
        'concurrency',
        cliOverrides.concurrency,
        envOverrides.concurrency,
        project?.concurrency,
        global?.concurrency,
        DEFAULTS.concurrency,
      ),
      // editorConcurrency is not exposed via CliOverrides or env — project/global only.
      editorConcurrency: track(
        'editorConcurrency',
        undefined,
        undefined,
        project?.editorConcurrency,
        global?.editorConcurrency,
        DEFAULTS.editorConcurrency,
      ),
      // allowForcePush is not exposed via CliOverrides or env — project/global only.
      allowForcePush: track(
        'allowForcePush',
        undefined,
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
      // Run-level cost/token ceilings (issue #190), project > global. Omitted when unset so the
      // adapter builds no budget check and the run is byte-identical.
      ...((project?.maxCostUsd ?? global?.maxCostUsd) !== undefined
        ? { maxCostUsd: project?.maxCostUsd ?? global?.maxCostUsd }
        : {}),
      ...((project?.maxTotalTokens ?? global?.maxTotalTokens) !== undefined
        ? { maxTotalTokens: project?.maxTotalTokens ?? global?.maxTotalTokens }
        : {}),
      ...(prBodySections !== undefined ? { prBodySections } : {}),
      ...(providerRouting !== undefined ? { providerRouting } : {}),
      ...(fallbackModels !== undefined ? { fallbackModels } : {}),
      reasoningEffort: reasoningEffort.value,
      bashRules,
      // Per-role MCP allowlist — aitm config only, project over global (issue #115). Omitted when
      // neither sets it, so every role gets every connected server.
      ...((project?.mcpRoleAllowlist ?? global?.mcpRoleAllowlist)
        ? { mcpRoleAllowlist: project?.mcpRoleAllowlist ?? global?.mcpRoleAllowlist }
        : {}),
      // Defer-tools threshold — aitm config only, project over global (issue #119). pick() treats a
      // configured 0 as set (!== undefined), so "always defer" survives the default.
      mcpDeferToolsOver: track(
        'mcpDeferToolsOver',
        undefined,
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
      // streaming is not exposed via CliOverrides — project/global only (slice 07).
      streaming: track(
        'streaming',
        undefined,
        undefined,
        project?.streaming,
        global?.streaming,
        DEFAULTS.streaming,
      ),
      mcpServers,
      mcpServerSources,
    };

    // Present-only keys carry a label only when a layer actually set them (omitted → no key, no
    // label). Provenance uses the same accessors and precedence order as the spreads above.
    const pr = pgpSource(
      project?.providerRouting,
      global?.providerRouting,
      profile?.providerRouting,
    );
    if (pr) sources.providerRouting = pr;
    const fm = pgpSource(project?.fallbackModels, global?.fallbackModels, profile?.fallbackModels);
    if (fm) sources.fallbackModels = fm;
    const pbs = pgSource(project?.prBodySections, global?.prBodySections);
    if (pbs) sources.prBodySections = pbs;
    const ws = pgSource(project?.webSearch, global?.webSearch);
    if (ws) sources.webSearch = ws;
    const mcu = pgSource(project?.maxCostUsd, global?.maxCostUsd);
    if (mcu) sources.maxCostUsd = mcu;
    const mtt = pgSource(project?.maxTotalTokens, global?.maxTotalTokens);
    if (mtt) sources.maxTotalTokens = mtt;
    const mra = pgSource(project?.mcpRoleAllowlist, global?.mcpRoleAllowlist);
    if (mra) sources.mcpRoleAllowlist = mra;
    if (global?.hooks) sources.hooks = 'global';

    return { resolved, sources };
  }

  async readGlobal(): Promise<ConfigFile | null> {
    return this.readConfigFile(join(this.homeDir, GLOBAL_FILE));
  }

  async readProject(): Promise<ConfigFile | null> {
    return this.readConfigFile(join(this.cwd, PROJECT_DIR, PROJECT_FILE));
  }

  // Hand every user-owned provider key to the literal-value redactor, so it can be scrubbed from
  // logs, the progress stream and error reports whatever format it is in — a key for an arbitrary
  // OpenAI-compatible endpoint matches none of the scrubber's vendor patterns. Every profile's key
  // is registered, not just the active one: an inactive profile's key can still reach an output
  // channel through an error message, an env dump or a mid-run profile switch.
  //
  // Project scope is deliberately excluded. Its openrouterApiKey is stripped upstream and never
  // used, and registering an attacker-chosen literal would let a hostile repo blank arbitrary text
  // out of the operator's own logs.
  private registerProviderSecrets(global: ConfigFile | null): void {
    registerSecretValues([
      this.env.OPENROUTER_API_KEY,
      global?.openrouterApiKey,
      ...Object.values(global?.profiles ?? {}).map((profile) => profile.openrouterApiKey),
    ]);
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
    this.stripProjectBashAllowRules(sanitized);
    return sanitized;
  }

  // `bashRules` governs the model-facing shell, so project scope may only TIGHTEN it: an `allow`
  // entry from a checked-in config would sit ahead of the DEFAULT_BASH_RULES denies under
  // first-match-wins and clear `git push --force` / `gh pr merge` / `git reset --hard` for an
  // untrusted repo. Denies survive — a repo adding one can only narrow what the model may run.
  // Mutates the sanitized copy stripUntrustedProjectFields owns; never the caller's object.
  private stripProjectBashAllowRules(sanitized: ConfigFile): void {
    const rules = sanitized.bashRules;
    if (!rules) return;
    const denies = rules.filter((rule) => rule.action === 'deny');
    const dropped = rules.length - denies.length;
    if (dropped > 0) {
      this.warnOnce(
        'bashRules',
        `${dropped} bashRules "allow" ${dropped === 1 ? 'rule' : 'rules'} in ./${PROJECT_DIR}/${PROJECT_FILE} ${dropped === 1 ? 'is' : 'are'} ignored — ` +
          'a project config may only add denies, never clear one; ' +
          `"allow" is honored only from the user-owned ~/${GLOBAL_FILE}`,
      );
    }
    if (denies.length > 0) sanitized.bashRules = denies;
    else delete sanitized.bashRules;
  }

  private warnUntrustedProjectField(key: string, reason: string): void {
    this.warnOnce(
      key,
      `${key} in ./${PROJECT_DIR}/${PROJECT_FILE} is ignored — ${reason}; honored only from the user-owned ~/${GLOBAL_FILE}`,
    );
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnedUntrustedProjectFields.has(key)) return;
    this.warnedUntrustedProjectFields.add(key);
    this.warn(message);
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
  // file is safe to inspect; only the resolution source is recorded. MCP server
  // secrets (headers, env) are also redacted.
  async writeSnapshot(resolved: ResolvedConfig, stateDir: string): Promise<void> {
    const redactedMcpServers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(resolved.mcpServers)) {
      const redactedServer: Record<string, unknown> = { ...server };
      if ('headers' in server) {
        redactedServer.headers = '<redacted>';
      }
      if ('env' in server) {
        redactedServer.env = '<redacted>';
      }
      redactedMcpServers[name] = redactedServer;
    }
    const redacted: ResolvedConfig = {
      ...resolved,
      openrouterApiKey: `<from ${resolved.apiKeySource}>`,
      mcpServers: redactedMcpServers as typeof resolved.mcpServers,
    };
    const path = join(stateDir, SNAPSHOT_FILE);
    await atomicWrite(path, `${JSON.stringify(redacted, null, 2)}\n`);
  }

  // Reads any JSON file whose only field we care about is `mcpServers` (Claude Code's
  // .mcp.json or the much larger ~/.claude.json). Missing file → null. Malformed JSON
  // is a hard error — we don't want to silently ignore a corrupted user file.
  private async readMcpEnvelope(path: string): Promise<McpServers | null> {
    const parsed = await readJsonFile(path);
    if (parsed === undefined) return null;
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
        // Every transport is honored from every scope, stdio included: a repo's ./.mcp.json is the
        // file its Claude Code session already spawns those servers from, and refusing to run them
        // made aitm useless in exactly the repos that declare them. Running a checkout's tooling is
        // the operator's decision, made when they run `aitm start` in it — the other project-scope
        // strips (stripUntrustedProjectFields) stand, since those redirect the harness itself.
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
    const parsed = await readJsonFile(path);
    if (parsed === undefined) return null;
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
      if (!CONFIG_KEYS.has(k)) {
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
    const profiles = global?.profiles;
    // Own-property lookup: `profiles.__proto__` would otherwise resolve to Object.prototype and
    // be treated as a configured profile (a config written before profile names were validated
    // can still point there).
    const profile = profiles && Object.hasOwn(profiles, name) ? profiles[name] : undefined;
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
  // fallback — with ONE carve-out: a top-level `baseURL` only outranks an active profile's `baseURL`
  // when the global config ALSO carries a top-level `openrouterApiKey`, i.e. a self-consistent
  // endpoint+key pair. A top-level `baseURL` with no matching top-level key is STALE (typically an
  // old `aitm config set baseURL` left behind before the profile was created): keeping it would pair
  // that host with the active profile's (or env's) key and send the key to a different provider —
  // the exact mismatch resolveApiKey guards against. So when the profile supplies its own `baseURL`,
  // it wins and owns the endpoint (its key then follows via baseURLSource='profile'); the stale
  // top-level `baseURL` is dropped with a loud warning. When the top-level IS a coherent pair it
  // still wins (an explicit top-level config is deliberate), but we warn that `profile use` did not
  // switch the host. Identical URLs are a no-op (no shadowing, no warning).
  // Project scope is NEVER consulted: a project-set baseURL is stripped upstream
  // (stripUntrustedProjectFields) so an untrusted repo can't redirect inference or leak the key.
  // Undefined → provider default. Config-file values are already URL-validated by ConfigFileSchema;
  // the env value is validated here so every source honors the same "validated as a URL" contract
  // (docs/auth.md §"Base URL"). A whitespace-only / empty env var means "no override".
  private resolveBaseURL(
    global: ConfigFile | null,
    profile: Profile | undefined,
    profileName: string | undefined,
  ): { baseURL: string | undefined; baseURLSource: 'global' | 'profile' | 'env' | undefined } {
    if (global?.baseURL) {
      if (profile?.baseURL && profile.baseURL !== global.baseURL) {
        const label = profileName ? `the active profile "${profileName}"` : 'the active profile';
        if (global.openrouterApiKey) {
          this.warn(
            `Top-level "baseURL" (${global.baseURL}) in ~/.aitm.json overrides ${label}'s baseURL ` +
              `(${profile.baseURL}); the profile switch did not change the endpoint. Remove the ` +
              `top-level "baseURL"/"openrouterApiKey" to let the profile own the endpoint.`,
          );
        } else {
          this.warn(
            `Top-level "baseURL" (${global.baseURL}) in ~/.aitm.json has no matching top-level ` +
              `"openrouterApiKey" — it is stale. Using ${label}'s baseURL (${profile.baseURL}) ` +
              `instead so its key reaches the right host. Remove the top-level "baseURL" to silence this.`,
          );
          return { baseURL: profile.baseURL, baseURLSource: 'profile' };
        }
      }
      return { baseURL: global.baseURL, baseURLSource: 'global' };
    }
    if (profile?.baseURL) return { baseURL: profile.baseURL, baseURLSource: 'profile' };
    const env = this.env.OPENROUTER_BASE_URL?.trim();
    if (!env) return { baseURL: undefined, baseURLSource: undefined };
    const parsed = z.url().safeParse(env);
    if (!parsed.success) {
      throw new Error(`OPENROUTER_BASE_URL is not a valid URL: ${JSON.stringify(env)}`);
    }
    return { baseURL: parsed.data, baseURLSource: 'env' };
  }

  // The key and the baseURL must name the SAME provider — a mismatched pair silently sends one
  // provider's key to another's endpoint (e.g. a legacy top-level OpenRouter key against a profile's
  // z.ai baseURL → a 401 the user can't diagnose). So the key is resolved to match where the baseURL
  // came from (`baseURLSource`):
  //   - baseURL from the active profile (it switched the endpoint): use the profile's own key, or env
  //     — never the top-level key, which belongs to the default/other provider. If neither exists the
  //     run fails with an actionable error (the caller reports the missing profile key).
  //   - baseURL from global/env/default (no profile endpoint switch): the legacy precedence holds —
  //     top-level global key wins, then the profile key, then env.
  // Project scope is NEVER consulted: a project-set openrouterApiKey is stripped upstream
  // (stripUntrustedProjectFields), so an untrusted repo can't swap the provider credential.
  private resolveApiKey(
    global: ConfigFile | null,
    profile: Profile | undefined,
    baseURLSource: 'global' | 'profile' | 'env' | undefined,
  ): { apiKey: string | undefined; apiKeySource: ResolvedConfig['apiKeySource'] | undefined } {
    const envKey = this.env.OPENROUTER_API_KEY;
    if (baseURLSource === 'profile') {
      // The profile owns the endpoint, so it must own the key. A top-level key here is for a
      // different provider and is deliberately NOT used.
      if (profile?.openrouterApiKey) {
        return { apiKey: profile.openrouterApiKey, apiKeySource: 'profile' };
      }
      if (envKey) {
        return { apiKey: envKey, apiKeySource: 'env' };
      }
      return { apiKey: undefined, apiKeySource: undefined };
    }
    if (global?.openrouterApiKey) {
      return { apiKey: global.openrouterApiKey, apiKeySource: 'global' };
    }
    if (profile?.openrouterApiKey) {
      return { apiKey: profile.openrouterApiKey, apiKeySource: 'profile' };
    }
    if (envKey) {
      return { apiKey: envKey, apiKeySource: 'env' };
    }
    return { apiKey: undefined, apiKeySource: undefined };
  }

  // Env overrides for the run settings a CI wrapper most commonly needs to tune without writing
  // `.ai-task-master/config.json` (findings/03-cli-config.md: "only OPENROUTER_API_KEY/
  // OPENROUTER_BASE_URL exist as env overrides"). Deliberately NOT exhaustive: CLI-only settings
  // (adminMerge, allowDirty) stay CLI-only on purpose (see their track() call sites), and per-repo
  // toggles (resolveConflicts, generateSpecialists, editorConcurrency, …) have no per-run env knob.
  // Each var is validated the same way its config-file counterpart is; an unset or blank-string env
  // var means "no override" (falls through to project/global/default), never a parse error.
  private resolveEnvOverrides(): EnvOverrides {
    return {
      maxPrs: parseEnvInt('AITM_MAX_PRS', this.env.AITM_MAX_PRS),
      // 0 means unlimited (null), matching --max-sessions's own 0 → null convention.
      maxSessions: parseEnvMaxSessions(this.env.AITM_MAX_SESSIONS),
      maxCiFixAttempts: parseEnvInt('AITM_MAX_CI_FIX_ATTEMPTS', this.env.AITM_MAX_CI_FIX_ATTEMPTS),
      concurrency: parseEnvInt('AITM_CONCURRENCY', this.env.AITM_CONCURRENCY),
      autoMerge: parseEnvBool('AITM_AUTO_MERGE', this.env.AITM_AUTO_MERGE),
      prPerTask: parseEnvBool('AITM_PR_PER_TASK', this.env.AITM_PR_PER_TASK),
      selfReview: parseEnvBool('AITM_SELF_REVIEW', this.env.AITM_SELF_REVIEW),
      mergeMethod: parseEnvMergeMethod(this.env.AITM_MERGE_METHOD),
      logLevel: parseEnvLogLevel(this.env.AITM_LOG_LEVEL),
    };
  }

  // Layer order (lowest → highest): defaults < active profile < global < project < CLI.
  // The profile fills tiers it specifies; explicit config still overrides per tier. `sources` records
  // the last layer that set each tier (independent per tier), for `config list --effective`.
  private resolveModels(
    global: ConfigFile | null,
    project: ConfigFile | null,
    profile: Profile | undefined,
    cliOverrides: CliOverrides,
  ): { value: ResolvedConfig['models']; sources: Record<Capability, ConfigSource> } {
    const value: ResolvedConfig['models'] = {
      generic: DEFAULT_MODELS.generic,
      smart: DEFAULT_MODELS.smart,
      coding: DEFAULT_MODELS.coding,
      fast: DEFAULT_MODELS.fast,
    };
    const sources: Record<Capability, ConfigSource> = {
      generic: 'default',
      smart: 'default',
      coding: 'default',
      fast: 'default',
    };
    for (const [layer, src] of [
      ['profile', profile?.models],
      ['global', global?.models],
      ['project', project?.models],
    ] as const) {
      if (!src) continue;
      if (src.generic) {
        value.generic = src.generic;
        sources.generic = layer;
      }
      if (src.smart) {
        value.smart = src.smart;
        sources.smart = layer;
      }
      if (src.coding) {
        value.coding = src.coding;
        sources.coding = layer;
      }
      if (src.fast) {
        value.fast = src.fast;
        sources.fast = layer;
      }
    }
    // --model pins the `generic` tier — the fallback every other capability
    // inherits when not explicitly set. See docs/config.md §"Per-role models".
    if (cliOverrides.model) {
      value.generic = cliOverrides.model;
      sources.generic = 'cli';
    }
    return { value, sources };
  }

  // Per-capability reasoning effort, merged profile < global < project (issue #125). No CLI
  // override and no built-in defaults — starts empty, so an unconfigured capability carries no
  // effort and its request stays byte-identical. `generic` is a plain capability here, NOT a
  // fallback for the other tiers (unlike resolveModels' generic).
  private resolveReasoningEffort(
    global: ConfigFile | null,
    project: ConfigFile | null,
    profile: Profile | undefined,
  ): {
    value: ResolvedConfig['reasoningEffort'];
    sources: Partial<Record<Capability, ConfigSource>>;
  } {
    const value: ResolvedConfig['reasoningEffort'] = {};
    const sources: Partial<Record<Capability, ConfigSource>> = {};
    for (const [layer, src] of [
      ['profile', profile?.reasoningEffort],
      ['global', global?.reasoningEffort],
      ['project', project?.reasoningEffort],
    ] as const) {
      if (!src) continue;
      if (src.generic) {
        value.generic = src.generic;
        sources.generic = layer;
      }
      if (src.smart) {
        value.smart = src.smart;
        sources.smart = layer;
      }
      if (src.coding) {
        value.coding = src.coding;
        sources.coding = layer;
      }
      if (src.fast) {
        value.fast = src.fast;
        sources.fast = layer;
      }
    }
    return { value, sources };
  }
}

// The layer a pick(cli, env, project, global, fallback) resolved to, by the same first-defined
// rule. cli > env > project > global > default (docs/config.md §"Resolution order").
function layerOf<T>(
  cli: T | undefined,
  env: T | undefined,
  project: T | undefined,
  global: T | undefined,
): ConfigSource {
  if (cli !== undefined) return 'cli';
  if (env !== undefined) return 'env';
  if (project !== undefined) return 'project';
  if (global !== undefined) return 'global';
  return 'default';
}

// Provenance for a present-only project > global field: undefined when neither layer set it (so the
// key was omitted from the resolved config and must carry no label).
function pgSource<T>(project: T | undefined, global: T | undefined): ConfigSource | undefined {
  if (project !== undefined) return 'project';
  if (global !== undefined) return 'global';
  return undefined;
}

// Provenance for a present-only project > global > profile field (the provider-shaped maps).
function pgpSource<T>(
  project: T | undefined,
  global: T | undefined,
  profile: T | undefined,
): ConfigSource | undefined {
  if (project !== undefined) return 'project';
  if (global !== undefined) return 'global';
  if (profile !== undefined) return 'profile';
  return undefined;
}

function pick<T>(
  cli: T | undefined,
  env: T | undefined,
  project: T | undefined,
  global: T | undefined,
  fallback: T,
): T {
  if (cli !== undefined) return cli;
  if (env !== undefined) return env;
  if (project !== undefined) return project;
  if (global !== undefined) return global;
  return fallback;
}

function pickNullable<T>(
  cli: T | null | undefined,
  env: T | null | undefined,
  project: T | null | undefined,
  global: T | null | undefined,
  fallback: T | null,
): T | null {
  if (cli !== undefined) return cli;
  if (env !== undefined) return env;
  if (project !== undefined) return project;
  if (global !== undefined) return global;
  return fallback;
}

// Permissive envelope for Claude Code config files: we only extract `mcpServers` and
// ignore every other key (~/.claude.json especially has many auth/history fields).
const McpEnvelopeSchema = z
  .object({
    mcpServers: McpServersSchema.optional(),
  })
  .passthrough();

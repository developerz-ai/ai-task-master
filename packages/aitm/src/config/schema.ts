// docs/config.md §Schema, docs/auth.md §LLM provider
// Models are configured by *capability tier*, not by subagent role. The mapping
// role → tier lives in src/credentials/credentials.ts.
//   generic — fallback for anything not otherwise specified
//   smart   — best reasoning (Planner, Reviewer)
//   coding  — code generation / edits (Worker)
//   fast    — cheap routing / summarization (Orchestrator, toModelOutput compaction)

import type { CommandRule } from '@developerz.ai/ai-claude-compat';
import { z } from 'zod';
import { McpRoleAllowlistSchema, McpServersSchema } from '../mcp/schema.ts';

// A model-facing bash deny/allow rule (issue #113). Structurally the compat CommandRule; the schema
// validates config-file input and ResolvedConfig carries the compat type.
// One PreToolUse/PostToolUse hook (issue #121): a shell command gated by an optional glob matcher on
// the tool name, with an optional per-hook timeout. Mirrors the compat ToolHooks shape.
export const HookSpecSchema = z.object({
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

export const ToolHooksSchema = z.object({
  preToolUse: z.array(HookSpecSchema).optional(),
  postToolUse: z.array(HookSpecSchema).optional(),
});

export const CommandRuleSchema = z.object({
  // Trim before the length check: a whitespace-only pattern would split to zero tokens and silently
  // never match — a fail-open deny rule. Reject it at config-parse time instead (issue #113).
  pattern: z.string().trim().min(1),
  action: z.enum(['deny', 'allow']),
});

export const CapabilityModelsSchema = z
  .object({
    generic: z.string().optional(),
    smart: z.string().optional(),
    coding: z.string().optional(),
    fast: z.string().optional(),
  })
  .passthrough();

export type CapabilityModels = z.infer<typeof CapabilityModelsSchema>;
export type Capability = 'generic' | 'smart' | 'coding' | 'fast';

// OpenRouter provider-routing controls (issue #124). camelCase config keys map onto the snake_case
// `provider.*` chat-settings fields in Credentials. Handle-level: one value applies to all roles.
export const ProviderSortSchema = z.enum(['price', 'throughput', 'latency']);
export const ProviderRoutingSchema = z.object({
  order: z.array(z.string()).optional(),
  allowFallbacks: z.boolean().optional(),
  requireParameters: z.boolean().optional(),
  sort: ProviderSortSchema.optional(),
  only: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
});
export type ProviderRouting = z.infer<typeof ProviderRoutingSchema>;

// Per-capability alternate model ids OpenRouter fails over to on a provider/model outage (issue
// #124), mapped onto the top-level `models: string[]` chat setting. Mirrors CapabilityModelsSchema.
export const FallbackModelsSchema = z
  .object({
    generic: z.array(z.string()).optional(),
    smart: z.array(z.string()).optional(),
    coding: z.array(z.string()).optional(),
    fast: z.array(z.string()).optional(),
  })
  .passthrough();
export type FallbackModels = z.infer<typeof FallbackModelsSchema>;

// OpenRouter reasoning-effort tiers (issue #125). Emitted as `reasoning: { effort }` on the model
// handle for a capability with an effort configured. The union's effort arm — a token-budget arm
// can join later without a breaking change. Recommended tiers ship as docs only (see defaults.ts):
// shipping defaults would change request bytes for every existing user and push the param to
// endpoints that may reject it (custom baseURL, non-reasoning models). Strictly opt-in.
export const ReasoningEffortSchema = z.enum(['xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

// Per-capability reasoning effort. Mirrors the per-tier-optional shape of CapabilityModelsSchema;
// resolved as a per-capability merge (project > global > profile). `generic` applies only to
// explicit generic-capability resolution — unlike models.generic it is NOT a fallback for other
// tiers.
export const ReasoningEffortMapSchema = z
  .object({
    generic: ReasoningEffortSchema.optional(),
    smart: ReasoningEffortSchema.optional(),
    coding: ReasoningEffortSchema.optional(),
    fast: ReasoningEffortSchema.optional(),
  })
  .passthrough();
export type ReasoningEffortMap = z.infer<typeof ReasoningEffortMapSchema>;

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export const MergeMethodSchema = z.enum(['squash', 'merge', 'rebase']);

// A named provider profile: the provider "triple" (key + base URL + per-tier models)
// bundled under one name so `aitm profile use <name>` switches the whole provider in one
// command, version-manager style. Profiles only carry provider-shaped fields — run
// settings (maxPrs, autoMerge, …) stay at the top level. See docs/commands/profile.md.
export const ProfileSchema = z
  .object({
    openrouterApiKey: z.string().optional(),
    baseURL: z.url().optional(),
    models: CapabilityModelsSchema.optional(),
    // Provider-shaped, so profile-able (issues #124, #125).
    providerRouting: ProviderRoutingSchema.optional(),
    fallbackModels: FallbackModelsSchema.optional(),
    reasoningEffort: ReasoningEffortMapSchema.optional(),
  })
  .passthrough();

export type Profile = z.infer<typeof ProfileSchema>;

export const ConfigFileSchema = z
  .object({
    // Provider credential. User-owned only: honored from ~/.aitm.json (or a profile), ignored +
    // warned from a project config.json (untrusted-repo trust boundary). See config-loader.ts.
    openrouterApiKey: z.string().optional(),
    // Name of the profile in `profiles` whose provider fields seed this config. Unset →
    // no profile layer (current behavior). See docs/config.md §"Profiles" for precedence.
    activeProfile: z.string().optional(),
    // Named provider profiles. Global-only (write surface is `aitm profile …`). The active
    // one supplies provider defaults between explicit top-level config and env. See profiles.ts.
    profiles: z.record(z.string(), ProfileSchema).optional(),
    // Override the OpenAI-compatible inference base URL. Unset → the provider default
    // (https://openrouter.ai/api/v1). Lets aitm target any OpenAI-compatible endpoint
    // (e.g. a self-hosted gateway or the z.ai GLM coding plan) without an Anthropic SDK.
    // User-owned only: honored from ~/.aitm.json (or a profile), ignored + warned from a project
    // config.json — a project-set baseURL could redirect inference and leak the key as a Bearer
    // token (untrusted-repo trust boundary). See docs/auth.md §"LLM provider" and config-loader.ts.
    baseURL: z.url().optional(),
    models: CapabilityModelsSchema.optional(),
    // OpenRouter provider routing + per-capability model fallback (issue #124). Provider-shaped, so
    // also on ProfileSchema; resolved project > global > profile like baseURL.
    providerRouting: ProviderRoutingSchema.optional(),
    fallbackModels: FallbackModelsSchema.optional(),
    // Per-capability OpenRouter reasoning effort (issue #125). Provider-shaped, so also on
    // ProfileSchema; resolved as a per-capability merge (project > global > profile).
    reasoningEffort: ReasoningEffortMapSchema.optional(),
    maxPrs: z.number().int().positive().optional(),
    maxSessions: z.number().int().positive().nullable().optional(),
    // Cap on CI-fix passes per PR group before it blocks for a human (issue #128). Bounds the
    // waiting-ci ⇄ ci-failed recovery loop on an unfixable red PR. See src/loop/work-loop.ts.
    maxCiFixAttempts: z.number().int().positive().optional(),
    // Per-step LLM request deadline in ms (issue #129). Armed on every generate call so a stalled
    // provider cannot hang an unattended run. Bounds one step — a provider HTTP call plus that step's
    // tool executions — never the whole run. Must clear the bash-tool ceiling (600s) plus a slow
    // high-effort completion, so ≥ 1000 and defaulted high. See src/subagents + docs/config.md.
    llmStepTimeoutMs: z.number().int().min(1000).optional(),
    autoMerge: z.boolean().optional(),
    mergeMethod: MergeMethodSchema.optional(),
    stylePath: z.string().nullable().optional(),
    // Shell command run in the checkout by the Worker before `git add -A`, so the committed
    // diff matches the project's formatter (e.g. "bun run lint:fix"). Unset → no format step.
    // See src/subagents/worker.ts §commitOnBranch and issue #48.
    formatCommand: z.string().optional(),
    // Shell command run in the checkout by the Worker after the editor fanout + formatCommand and
    // before `git add`, so a diff that fails tests/lint never opens a red PR. A non-zero exit
    // triggers one bounded local fix pass; if it still fails the group blocks without committing.
    // Unset → no verify step. See src/subagents/worker.ts and issue #122.
    verifyCommand: z.string().optional(),
    // Run a coordinator-driven adversarial self-review + verify + fix pass over the just-committed
    // diff BEFORE opening each PR (default true). aitm must never open a PR it hasn't reviewed and
    // verified itself — external CI / CodeRabbit are backstops, not the only gate. Set false to open
    // the PR straight after the Worker commits (pre-selfReview behavior). See src/loop/self-review.ts.
    selfReview: z.boolean().optional(),
    // Hand a rebase/merge conflict to an AI subagent to resolve, then retry the force-push + merge,
    // instead of blocking the group for manual resolution (default true). Bounded attempts; an
    // unresolvable conflict still aborts the rebase and blocks. See src/loop/ci-fix.ts and
    // src/loop/conflict-resolution.ts.
    resolveConflicts: z.boolean().optional(),
    logLevel: LogLevelSchema.optional(),
    // How many PR groups may have a Worker running at the same time. Default 1 = sequential.
    // See src/loop/work-loop.ts and src/workspace/in-place-checkout.ts.
    concurrency: z.number().int().positive().optional(),
    // How many editor files the Worker may process in parallel during team fanout. Default 4, min 1.
    // See src/subagents/worker.ts and issue #178.
    editorConcurrency: z.number().int().min(1).optional(),
    // Whether aitm may force-push (`--force-with-lease`, used by the CI-fix rebase flow). Default
    // true. Set false on repos that forbid all force-pushes; the CI-fix push then blocks instead.
    allowForcePush: z.boolean().optional(),
    // Attach OpenRouter's server-side web_search tool to Worker generate calls (issue #112). Unset →
    // enabled for CI-fix sessions only (highest lookup value, bounded cost); true → all Worker calls;
    // false → never. See src/loop/run-loop-adapter.ts §web-search gating.
    webSearch: z.boolean().optional(),
    // Per-repo PR body section headings (each a `## ` heading, in order). Unset → the default
    // Summary/Changes/Testing. See src/orchestrator/orchestrator.ts §resolvePrBodySections.
    prBodySections: z.array(z.string()).optional(),
    // Deny/allow rules for the model-facing bash tool (issue #113). Resolved wholesale (project over
    // global) and appended before the built-in destructive-command defaults; first-match-wins.
    bashRules: z.array(CommandRuleSchema).optional(),
    // External MCP servers to mount into subagent tool surfaces (client only — aitm is never
    // exposed as an MCP server). See docs/mcp.md and src/mcp/schema.ts.
    mcpServers: McpServersSchema.optional(),
    // Per-role MCP allowlist (issue #115): whole servers by name or per-server `*`-glob tool
    // patterns. aitm-config-only (project > global); the Claude Code interop sources contribute
    // mcpServers alone. See src/mcp/schema.ts and src/mcp/mcp-client.ts.
    mcpRoleAllowlist: McpRoleAllowlistSchema.optional(),
    // Defer a role's MCP tools to name-only stubs + `tool_search` once their count exceeds this
    // (issue #119), keeping their JSON schemas out of every request. Default 20; 0 = always defer.
    // aitm-config-only (project > global). See src/mcp/mcp-client.ts and src/mcp/tool-search.ts.
    mcpDeferToolsOver: z.number().int().min(0).optional(),
    // PreToolUse/PostToolUse shell hooks on the tool registry (issue #121). Hooks run shell commands
    // with operator privileges, so they are honored ONLY from the user-owned global config
    // (~/.aitm.json); the same key in a repo-shippable project config is parsed but ignored + warned.
    // See config-loader.ts, src/loop/run-loop-adapter.ts, and ai-claude-compat withHooks.
    hooks: ToolHooksSchema.optional(),
    // Route subagent generate calls through the AI SDK's streamText funnel instead of generateText
    // (slice 07), so text and tool-call lines render live as the model streams instead of after each
    // step finishes. Higher risk (a two-regime stall watchdog covers it) — default false until
    // burn-in; config-only, no CLI flag. See src/observability/step-progress.ts
    // createLiveStreamRenderer and @developerz.ai/ai-claude-compat's SubagentConfig.onStream.
    streaming: z.boolean().optional(),
  })
  .passthrough();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

// Every recognized top-level config key, derived from ConfigFileSchema's shape so it can never
// drift from the schema. Single source of truth for both write and read surfaces: ConfigWriter
// rejects a `config set` on any key outside this set, and ConfigLoader warns on any file key outside
// it. Add a key to ConfigFileSchema and both tables pick it up automatically.
export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(ConfigFileSchema.shape));

export type CliOverrides = {
  maxPrs?: number;
  maxSessions?: number | null;
  maxCiFixAttempts?: number;
  autoMerge?: boolean;
  prPerTask?: boolean;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  // Force-merge past base-branch protection via `gh pr merge --admin`. CLI-only (per run),
  // not a persisted config-file key. Default false.
  adminMerge?: boolean;
  stylePath?: string | null;
  model?: string;
  concurrency?: number;
};

export type ResolvedConfig = {
  openrouterApiKey: string;
  // Where the resolved key came from. Never 'project' — a project config's openrouterApiKey is
  // stripped as an untrusted-repo trust boundary (ConfigLoader.stripUntrustedProjectFields).
  apiKeySource: 'global' | 'env' | 'profile';
  // Name of the active provider profile, if one supplied provider defaults for this run.
  // Undefined → no profile layer. Recorded for the snapshot and `aitm config list`.
  activeProfile?: string | undefined;
  // Optional OpenAI-compatible base URL override. Undefined → the provider default. User-owned only:
  // resolved global > profile config, then the OPENROUTER_BASE_URL env var as fallback; a project
  // config's baseURL is stripped (untrusted-repo trust boundary), so it is never attacker-set.
  baseURL?: string | undefined;
  models: Required<Pick<CapabilityModels, 'generic' | 'smart' | 'coding' | 'fast'>>;
  // OpenRouter provider routing + per-capability fallback model ids (issue #124). Omitted when unset
  // so the constructed chat settings stay byte-identical to today for existing installs.
  providerRouting?: ProviderRouting | undefined;
  fallbackModels?: FallbackModels | undefined;
  // Per-capability OpenRouter reasoning effort (issue #125). Defaults to {} — a capability with no
  // entry gets no `reasoning` key, so with nothing configured every request stays byte-identical.
  reasoningEffort: Partial<Record<Capability, ReasoningEffort>>;
  maxPrs: number;
  maxSessions: number | null;
  // Cap on CI-fix passes per PR group before it blocks. Default DEFAULT_MAX_CI_FIX_ATTEMPTS. #128.
  maxCiFixAttempts: number;
  // Per-step LLM request deadline in ms. Default DEFAULT_LLM_STEP_TIMEOUT_MS. Issue #129.
  llmStepTimeoutMs: number;
  autoMerge: boolean;
  prPerTask: boolean;
  mergeMethod: 'squash' | 'merge' | 'rebase';
  // Whether merges pass `gh pr merge --admin` to override base-branch policy. CLI-only, default
  // false. Optional so existing test fixtures that build ResolvedConfig literals stay valid.
  adminMerge?: boolean;
  stylePath: string | null;
  formatCommand: string | null;
  verifyCommand: string | null;
  // Whether the pre-PR self-review pass runs (default true). Adversarially reviews + verifies + fixes
  // the just-committed diff before every openPr. See src/loop/self-review.ts and src/loop/work-loop.ts.
  selfReview: boolean;
  // Whether a rebase/merge conflict is handed to an AI subagent to resolve before blocking (default
  // true). Bounded retries; an unresolvable conflict still blocks. See src/loop/ci-fix.ts.
  resolveConflicts: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  concurrency: number;
  // How many editor files may be processed in parallel during team fanout. Default 4.
  editorConcurrency: number;
  // Whether aitm may force-push (`--force-with-lease`). Default true.
  allowForcePush: boolean;
  // Whether OpenRouter web_search rides Worker calls (issue #112). Tri-state, so NOT collapsed to a
  // default: undefined → CI-fix sessions only; true → all Worker calls; false → never.
  webSearch?: boolean | undefined;
  // Per-repo PR body section headings. Undefined → orchestrator uses its default set.
  prBodySections?: readonly string[] | undefined;
  // Effective bash deny/allow rules: configured rules (project over global) followed by the built-in
  // destructive-command defaults, so every consumer sees one final first-match-wins list (issue #113).
  bashRules: readonly CommandRule[];
  // Merged MCP server map across all discovered sources (see ConfigLoader.resolve for
  // precedence). Empty object when nothing was found — never undefined, so callers can
  // iterate without null-checks.
  mcpServers: import('../mcp/schema.ts').McpServers;
  // Per-role MCP allowlist (issue #115), aitm-config-only (project > global). Undefined → every role
  // gets every connected server. Passed into McpClientManager.
  mcpRoleAllowlist?: import('../mcp/schema.ts').McpRoleAllowlist | undefined;
  // Threshold above which a role's MCP tools are deferred (issue #119). Default
  // DEFAULT_MCP_DEFER_TOOLS_OVER; 0 = always defer. Passed into McpClientManager.
  mcpDeferToolsOver: number;
  // Tool-registry hooks (issue #121). Global config only (~/.aitm.json) — project hooks are ignored
  // as a code-execution trust boundary. Undefined → no hooks; behavior unchanged. Applied over the
  // resolved tool records in run-loop-adapter via withHooks.
  hooks?: z.infer<typeof ToolHooksSchema> | undefined;
  // Whether subagent generate calls stream live (slice 07). Default false until burn-in;
  // config-only, no CLI flag. See run-loop-adapter's onStream/createLiveStreamRenderer wiring.
  streaming: boolean;
  // One label per server name explaining where the entry came from. Useful for the
  // snapshot, `aitm config list`, and "duplicate name shadowed by X" warnings.
  mcpServerSources: Record<string, McpServerSource>;
};

export type McpServerSource = 'aitm-global' | 'aitm-project' | 'claude-mcp-project' | 'claude-user';

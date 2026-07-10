// docs/config.md §Schema, docs/auth.md §LLM provider
// Models are configured by *capability tier*, not by subagent role. The mapping
// role → tier lives in src/credentials/credentials.ts.
//   generic — fallback for anything not otherwise specified
//   smart   — best reasoning (Planner, Reviewer)
//   coding  — code generation / edits (Worker)
//   fast    — cheap routing / summarization (Orchestrator, toModelOutput compaction)

import type { CommandRule } from '@developerz.ai/ai-claude-compat';
import { z } from 'zod';
import { McpServersSchema } from '../mcp/schema.ts';

// A model-facing bash deny/allow rule (issue #113). Structurally the compat CommandRule; the schema
// validates config-file input and ResolvedConfig carries the compat type.
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
    // See docs/auth.md §"LLM provider".
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
    // Shell command run in the worktree by the Worker before `git add -A`, so the committed
    // diff matches the project's formatter (e.g. "bun run lint:fix"). Unset → no format step.
    // See src/subagents/worker.ts §commitOnBranch and issue #48.
    formatCommand: z.string().optional(),
    // Shell command run in the worktree by the Worker after the editor fanout + formatCommand and
    // before `git add`, so a diff that fails tests/lint never opens a red PR. A non-zero exit
    // triggers one bounded local fix pass; if it still fails the group blocks without committing.
    // Unset → no verify step. See src/subagents/worker.ts and issue #122.
    verifyCommand: z.string().optional(),
    logLevel: LogLevelSchema.optional(),
    // How many PR groups may have a Worker running at the same time. Default 1 = sequential.
    // See src/loop/work-loop.ts and src/workspace/worktree-pool.ts.
    concurrency: z.number().int().positive().optional(),
    // Whether aitm may force-push (`--force-with-lease`, used by the CI-fix rebase flow). Default
    // true. Set false on repos that forbid all force-pushes; the CI-fix push then blocks instead.
    allowForcePush: z.boolean().optional(),
    // Per-repo PR body section headings (each a `## ` heading, in order). Unset → the default
    // Summary/Changes/Testing. See src/orchestrator/orchestrator.ts §resolvePrBodySections.
    prBodySections: z.array(z.string()).optional(),
    // Deny/allow rules for the model-facing bash tool (issue #113). Resolved wholesale (project over
    // global) and appended before the built-in destructive-command defaults; first-match-wins.
    bashRules: z.array(CommandRuleSchema).optional(),
    // External MCP servers to mount into subagent tool surfaces (client only — aitm is never
    // exposed as an MCP server). See docs/mcp.md and src/mcp/schema.ts.
    mcpServers: McpServersSchema.optional(),
  })
  .passthrough();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

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
  apiKeySource: 'project' | 'global' | 'env' | 'profile';
  // Name of the active provider profile, if one supplied provider defaults for this run.
  // Undefined → no profile layer. Recorded for the snapshot and `aitm config list`.
  activeProfile?: string | undefined;
  // Optional OpenAI-compatible base URL override. Undefined → the provider default.
  // Resolved from config (project > global) or the OPENROUTER_BASE_URL env var.
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
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  concurrency: number;
  // Whether aitm may force-push (`--force-with-lease`). Default true.
  allowForcePush: boolean;
  // Per-repo PR body section headings. Undefined → orchestrator uses its default set.
  prBodySections?: readonly string[] | undefined;
  // Effective bash deny/allow rules: configured rules (project over global) followed by the built-in
  // destructive-command defaults, so every consumer sees one final first-match-wins list (issue #113).
  bashRules: readonly CommandRule[];
  // Merged MCP server map across all discovered sources (see ConfigLoader.resolve for
  // precedence). Empty object when nothing was found — never undefined, so callers can
  // iterate without null-checks.
  mcpServers: import('../mcp/schema.ts').McpServers;
  // One label per server name explaining where the entry came from. Useful for the
  // snapshot, `aitm config list`, and "duplicate name shadowed by X" warnings.
  mcpServerSources: Record<string, McpServerSource>;
};

export type McpServerSource = 'aitm-global' | 'aitm-project' | 'claude-mcp-project' | 'claude-user';

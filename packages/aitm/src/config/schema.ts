// docs/config.md §Schema, docs/auth.md §LLM provider
// Models are configured by *capability tier*, not by subagent role. The mapping
// role → tier lives in src/credentials/credentials.ts.
//   generic — fallback for anything not otherwise specified
//   smart   — best reasoning (Planner, Reviewer)
//   coding  — code generation / edits (Worker)
//   fast    — cheap routing / summarization (Orchestrator, toModelOutput compaction)

import { z } from 'zod';
import { McpServersSchema } from '../mcp/schema.ts';

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
    maxPrs: z.number().int().positive().optional(),
    maxSessions: z.number().int().positive().nullable().optional(),
    autoMerge: z.boolean().optional(),
    mergeMethod: MergeMethodSchema.optional(),
    stylePath: z.string().nullable().optional(),
    // Shell command run in the worktree by the Worker before `git add -A`, so the committed
    // diff matches the project's formatter (e.g. "bun run lint:fix"). Unset → no format step.
    // See src/subagents/worker.ts §commitOnBranch and issue #48.
    formatCommand: z.string().optional(),
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
    // External MCP servers to mount into subagent tool surfaces (client only — aitm is never
    // exposed as an MCP server). See docs/mcp.md and src/mcp/schema.ts.
    mcpServers: McpServersSchema.optional(),
  })
  .passthrough();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type CliOverrides = {
  maxPrs?: number;
  maxSessions?: number | null;
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
  maxPrs: number;
  maxSessions: number | null;
  autoMerge: boolean;
  prPerTask: boolean;
  mergeMethod: 'squash' | 'merge' | 'rebase';
  // Whether merges pass `gh pr merge --admin` to override base-branch policy. CLI-only, default
  // false. Optional so existing test fixtures that build ResolvedConfig literals stay valid.
  adminMerge?: boolean;
  stylePath: string | null;
  formatCommand: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  concurrency: number;
  // Whether aitm may force-push (`--force-with-lease`). Default true.
  allowForcePush: boolean;
  // Per-repo PR body section headings. Undefined → orchestrator uses its default set.
  prBodySections?: readonly string[] | undefined;
  // Merged MCP server map across all discovered sources (see ConfigLoader.resolve for
  // precedence). Empty object when nothing was found — never undefined, so callers can
  // iterate without null-checks.
  mcpServers: import('../mcp/schema.ts').McpServers;
  // One label per server name explaining where the entry came from. Useful for the
  // snapshot, `aitm config list`, and "duplicate name shadowed by X" warnings.
  mcpServerSources: Record<string, McpServerSource>;
};

export type McpServerSource = 'aitm-global' | 'aitm-project' | 'claude-mcp-project' | 'claude-user';

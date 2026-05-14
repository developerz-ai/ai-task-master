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

export const ConfigFileSchema = z
  .object({
    openrouterApiKey: z.string().optional(),
    models: CapabilityModelsSchema.optional(),
    maxPrs: z.number().int().positive().optional(),
    maxSessions: z.number().int().positive().nullable().optional(),
    autoMerge: z.boolean().optional(),
    mergeMethod: MergeMethodSchema.optional(),
    stylePath: z.string().nullable().optional(),
    logLevel: LogLevelSchema.optional(),
    // How many PR groups may have a Worker running at the same time. Default 1 = sequential.
    // See src/loop/work-loop.ts and src/workspace/worktree-pool.ts.
    concurrency: z.number().int().positive().optional(),
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
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  stylePath?: string | null;
  model?: string;
  concurrency?: number;
};

export type ResolvedConfig = {
  openrouterApiKey: string;
  apiKeySource: 'project' | 'global' | 'env';
  models: Required<Pick<CapabilityModels, 'generic' | 'smart' | 'coding' | 'fast'>>;
  maxPrs: number;
  maxSessions: number | null;
  autoMerge: boolean;
  mergeMethod: 'squash' | 'merge' | 'rebase';
  stylePath: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  concurrency: number;
};

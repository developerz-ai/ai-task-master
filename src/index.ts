// Public surface. Keep this list narrow — most internals are not stable yet.

export { Logger } from './logger/logger.ts';
export { ConfigLoader } from './config/config-loader.ts';
export { ConfigWriter } from './config/config-writer.ts';
export { Credentials, ROLE_CAPABILITY } from './credentials/credentials.ts';
export { AgentConfigDetector } from './agent-config/agent-config-detector.ts';
export { StateStore } from './state/state-store.ts';
export { DEFAULT_PR_LABEL, GitHubClient } from './github/github-client.ts';
export { OpenRouterClient } from './openrouter/client.ts';
export { ModelLimitsRegistry } from './openrouter/model-limits.ts';
export { Compactor } from './compaction/compactor.ts';
export {
  providerOptionsWithServerTools,
  webFetchServerTool,
  webSearchTool,
} from './openrouter/server-tools.ts';
export { datetimeTool } from './tools/datetime.ts';
export { DEFAULT_STEALTH_HEADERS, webFetchTool } from './tools/web-fetch.ts';
export { McpClientManager } from './mcp/mcp-client.ts';
export type { McpServer, McpServers } from './mcp/schema.ts';
export { PlanGraph } from './plan/plan-graph.ts';
export { WorktreePool } from './workspace/worktree-pool.ts';
export { Orchestrator } from './orchestrator/orchestrator.ts';
export { WorkLoop } from './loop/work-loop.ts';
export { main } from './cli/cli.ts';

export type { ResolvedConfig, ConfigFile, Capability } from './config/schema.ts';
export type { RunState, PrGroup } from './state/schema.ts';
export type { Plan, PlannedGroup, PlannedTask } from './plan/schema.ts';
export type { AgentConfig } from './agent-config/agent-config-detector.ts';
export type { Role, ModelHandles } from './credentials/credentials.ts';

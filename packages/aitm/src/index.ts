// Public surface. Keep this list narrow — most internals are not stable yet.

export type { AgentConfig } from './agent-config/agent-config-detector.ts';
export { AgentConfigDetector } from './agent-config/agent-config-detector.ts';
export { main } from './cli/cli.ts';
export { Compactor } from './compaction/compactor.ts';
export { ConfigLoader } from './config/config-loader.ts';
export { ConfigWriter } from './config/config-writer.ts';
export type { Capability, ConfigFile, ResolvedConfig } from './config/schema.ts';
export type { ModelHandles, Role } from './credentials/credentials.ts';
export { Credentials, ROLE_CAPABILITY } from './credentials/credentials.ts';
export { DEFAULT_PR_LABEL, GitHubClient } from './github/github-client.ts';
export { Logger } from './logger/logger.ts';
export { WorkLoop } from './loop/work-loop.ts';
export { McpClientManager } from './mcp/mcp-client.ts';
export type { McpServer, McpServers } from './mcp/schema.ts';
export { OpenRouterClient } from './openrouter/client.ts';
export { ModelLimitsRegistry } from './openrouter/model-limits.ts';
export {
  providerOptionsWithServerTools,
  webFetchServerTool,
  webSearchTool,
} from './openrouter/server-tools.ts';
export { Orchestrator } from './orchestrator/orchestrator.ts';
export { PlanGraph } from './plan/plan-graph.ts';
export type { Plan, PlannedGroup, PlannedTask } from './plan/schema.ts';
export type { PrGroup, RunState } from './state/schema.ts';
export { StateStore } from './state/state-store.ts';
export { datetimeTool } from './tools/datetime.ts';
export { DEFAULT_STEALTH_HEADERS, webFetchTool } from './tools/web-fetch.ts';
export { WorktreePool } from './workspace/worktree-pool.ts';

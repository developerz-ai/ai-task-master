// docs/architecture.md §Flow, docs/subagents.md §Composition
// Top-level agent. Owns:
//   - prompt composition (style payload + role prefix + rolling context)
//   - routing between Planner / Worker / Reviewer (each exposed as a tool)
//   - **PR creation** — title, body, commit message: docs say Worker opens the PR,
//     but the Worker can be inconsistent on global-context narration. Orchestrator
//     re-composes the commit message and opens the PR via GitHubClient, taking the
//     Worker's draft as input. This is the reliability win: one place that knows
//     the whole plan writes the PR-level prose.
//
// SDK references:
//   docs/vendor/ai-sdk/chunk-04.md §"ToolLoopAgent"
//   docs/vendor/ai-sdk/chunk-09.md §"Subagents" §"Controlling What the Model Sees"
//   docs/vendor/ai-sdk/chunk-09.md §"Loop Control" — stopWhen: [stepCountIs(N), hasToolCall('done')]

import type { ToolLoopAgent } from 'ai';
import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import type { Credentials } from '../credentials/credentials.ts';
import type { GitHubClient } from '../github/github-client.ts';
import type { PullRequest } from '../github/schema.ts';
import type { PrGroup } from '../state/schema.ts';
import type { WorkerDelivery } from '../subagents/worker.ts';

export type OrchestratorInit = {
  credentials: Credentials;
  agentConfig: AgentConfig;
  rollingContext: string;
  maxSessions: number | null;
  github: GitHubClient;
};

export type OrchestratorTools = {
  planner: unknown;
  worker: unknown;
  reviewer: unknown;
};

export class Orchestrator {
  constructor(private readonly init: OrchestratorInit) {}

  // Build the top-level agent. systemPrompt = agentConfig.contents + orchestrator role prefix.
  build(): ToolLoopAgent<OrchestratorTools> {
    throw new Error('not implemented');
  }

  buildSystemPrompt(): string {
    throw new Error('not implemented');
  }

  // Take Worker's delivery, refine the commit message + commit on the group branch.
  // Returns the final commit SHA.
  async finalizeCommit(_group: PrGroup, _delivery: WorkerDelivery): Promise<string> {
    throw new Error('not implemented');
  }

  // Compose the PR title + body from group + delivery + rolling context, then create the PR.
  async openPr(_group: PrGroup, _delivery: WorkerDelivery): Promise<PullRequest> {
    throw new Error('not implemented');
  }
}

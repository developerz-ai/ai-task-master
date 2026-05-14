// docs/github-integration.md, docs/auth.md §"GitHub"
// Only module allowed to shell out to gh. Uses execa (docs/runtime.md — Bun.$ forbidden in src/).

import type { CheckStatus, PullRequest, ReviewThread } from './schema.ts';

export type CreatePrInput = {
  title: string;
  body: string;
  base: string;
  head: string;
  draft?: boolean;
  // Every PR `aitm` opens is tagged with this label so it's filterable in the GitHub UI.
  // Falls back to ['ai-task-master'] when not provided. Override via Orchestrator if needed.
  labels?: string[];
};

export const DEFAULT_PR_LABEL = 'ai-task-master';

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export class GitHubClient {
  // Capability matrix — docs/github-integration.md §"Capabilities".
  // Backoff — docs/github-integration.md §"Rate limits" (1s, doubling, 60s cap).

  constructor(private readonly cwd: string) {}

  async currentBranch(): Promise<string> {
    throw new Error('not implemented');
  }

  async defaultBranch(): Promise<string> {
    throw new Error('not implemented');
  }

  async getPrForBranch(_branch: string): Promise<PullRequest | null> {
    throw new Error('not implemented');
  }

  async createPr(_input: CreatePrInput): Promise<PullRequest> {
    throw new Error('not implemented');
  }

  async waitForChecks(_pr: number): Promise<CheckStatus> {
    throw new Error('not implemented');
  }

  async listUnresolvedThreads(_pr: number): Promise<ReviewThread[]> {
    throw new Error('not implemented');
  }

  async replyToThread(_threadId: string, _body: string): Promise<void> {
    throw new Error('not implemented');
  }

  async resolveThread(_threadId: string): Promise<void> {
    throw new Error('not implemented');
  }

  async mergePr(_pr: number, _method: MergeMethod): Promise<void> {
    throw new Error('not implemented');
  }

  async authStatus(): Promise<{ ok: boolean; scopes: string[] }> {
    throw new Error('not implemented');
  }
}

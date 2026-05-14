// docs/subagents.md (Reviewer row), docs/commands/merge-pr.md
// Input: unresolved review threads. Output: per-thread resolution (reply / push fix / mark stale).
// Pushes go through Worker tools (FS write, bash); thread ops via GitHubClient GraphQL.

import type { ToolLoopAgent } from 'ai';
import type { ReviewThread } from '../github/schema.ts';
import type { SubagentInit } from './factory.ts';

export type ReviewerTools = {
  readFile: unknown;
  writeFile: unknown;
  bash: unknown;
  github: unknown;
};

export type ReviewerInput = {
  pr: number;
  threads: ReviewThread[];
  worktreePath: string;
  styleContents: string;
};

export type ThreadResolution =
  | { threadId: string; kind: 'fixed'; commitSha: string }
  | { threadId: string; kind: 'replied' }
  | { threadId: string; kind: 'wontfix'; reason: string };

export type ReviewerResult =
  | { kind: 'ok'; resolutions: ThreadResolution[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

export function createReviewerAgent(_init: SubagentInit): ToolLoopAgent<ReviewerTools> {
  throw new Error('not implemented');
}

export async function runReviewer(
  _agent: ToolLoopAgent<ReviewerTools>,
  _input: ReviewerInput,
): Promise<ReviewerResult> {
  throw new Error('not implemented');
}

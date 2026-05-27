// Reviewer subagent's github tool — a thin LLM-facing wrapper around the two GitHubClient
// methods Reviewer needs: replyToThread + resolveThread. Kept as one discriminated-union
// tool so the SDK only registers a single `github` slot (matches the contract in
// src/subagents/reviewer.ts §ReviewerTools.github).
//
// Lifecycle parallels the claude-task-master `post_comment_replies()` flow (fix_pr.py):
//   1. agent decides per thread: fixed | replied | wontfix
//   2. agent calls github tool → replyToThread to post the reply
//   3. agent calls github tool → resolveThread to mark it resolved (skipped for "replied")
//
// `resolveThread` follows the same pattern: optional, only fired when the thread is "done".

import { type Tool, tool } from 'ai';
import { z } from 'zod';
import type { GithubToolInput, GithubToolOutput } from '../subagents/reviewer.ts';

// Minimal slice of GitHubClient surface this tool needs. Keeping it structural means tests
// can drop in a literal `{ replyToThread, resolveThread }` stub without subclassing.
export type GithubThreadClient = {
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
};

const githubInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('replyToThread'),
    threadId: z.string().min(1),
    body: z.string().min(1),
  }),
  z.object({
    action: z.literal('resolveThread'),
    threadId: z.string().min(1),
  }),
]);

export type GithubThreadToolInit = {
  github: GithubThreadClient;
};

export function githubThreadTool(
  init: GithubThreadToolInit,
): Tool<GithubToolInput, GithubToolOutput> {
  return tool({
    description:
      'Act on a single PR review thread. action="replyToThread" posts a reply; action="resolveThread" marks it resolved. Use replyToThread before resolveThread so the resolution carries an explanation.',
    inputSchema: githubInputSchema,
    execute: async (input): Promise<GithubToolOutput> => {
      switch (input.action) {
        case 'replyToThread':
          await init.github.replyToThread(input.threadId, input.body);
          return { ok: true };
        case 'resolveThread':
          await init.github.resolveThread(input.threadId);
          return { ok: true };
      }
    },
  });
}

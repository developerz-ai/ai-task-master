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

// The `github` tool's I/O contract. Flat (not a union) so the tool's parameter JSON-Schema isn't
// `oneOf` — several OpenRouter-routed providers reject `oneOf` in tool params ("Invalid arguments
// passed to the model"). `body` is used only by replyToThread. Lives with the tool; the Reviewer
// (subagents/reviewer.ts §ReviewerTools.github) imports it from here.
export type GithubToolInput = {
  action: 'replyToThread' | 'resolveThread';
  threadId: string;
  body?: string | undefined;
};
export type GithubToolOutput = { ok: boolean; error?: string };

// Minimal slice of GitHubClient surface this tool needs. Keeping it structural means tests
// can drop in a literal `{ replyToThread, resolveThread }` stub without subclassing.
export type GithubThreadClient = {
  replyToThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
};

// Flat object, not a discriminatedUnion: a union compiles to JSON-Schema `oneOf` in the tool's
// parameters, which some OpenRouter-routed providers reject ("Invalid arguments passed to the
// model"). `body` is required only for replyToThread (enforced in execute).
const githubInputSchema = z.object({
  action: z.enum(['replyToThread', 'resolveThread']),
  threadId: z.string().min(1),
  body: z.string().optional(),
});

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
      if (input.action === 'replyToThread') {
        if (!input.body?.trim()) {
          return { ok: false, error: 'body is required for replyToThread' };
        }
        await init.github.replyToThread(input.threadId, input.body);
        return { ok: true };
      }
      await init.github.resolveThread(input.threadId);
      return { ok: true };
    },
  });
}

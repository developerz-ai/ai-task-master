// docs/subagents.md (Reviewer row), docs/commands/merge-pr.md
// Input: unresolved review threads. Output: per-thread resolution (reply / push fix / mark stale).
// Pushes go through Worker tools (FS write, bash); thread ops via a `github` tool that wraps a
// subset of GitHubClient (replyToThread / resolveThread).
//
// Strategy:
//   - One agent.generate call per thread, scoped to that thread's conversation.
//   - Agent emits a structured ThreadResolutionOutput JSON describing the chosen outcome.
//   - For "fixed", the runner — not the agent — performs the git commit so commit shas are
//     deterministic and observable (worker pattern).
//
// SDK references:
//   chunk-04.md §"ToolLoopAgent"
//   chunk-05.md §"Generating Structured Data"
//   chunk-09.md §"Subagents"

import { type DeepPartial, Output, stepCountIs, type Tool, ToolLoopAgent } from 'ai';
import { z } from 'zod';
import type { ReviewThread } from '../github/schema.ts';
import type { SubagentInit } from './factory.ts';
import type {
  BashInput,
  BashOutput,
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
} from './worker.ts';

// Subset of GitHubClient methods exposed to the agent. Kept as a single discriminated tool so
// the SDK only registers one `github` slot — matches the task's tool surface contract.
export type GithubToolInput =
  | { action: 'replyToThread'; threadId: string; body: string }
  | { action: 'resolveThread'; threadId: string };
export type GithubToolOutput = { ok: boolean };

export type ReviewerTools = {
  readFile: Tool<ReadFileInput, ReadFileOutput>;
  writeFile: Tool<WriteFileInput, WriteFileOutput>;
  bash: Tool<BashInput, BashOutput>;
  github: Tool<GithubToolInput, GithubToolOutput>;
};

// Per-thread structured output emitted by the model. `fixed` carries the commit message the
// runner should use; `wontfix` carries the rationale.
export const ThreadResolutionOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), commitMessage: z.string().min(1) }),
  z.object({ kind: z.literal('replied') }),
  z.object({ kind: z.literal('wontfix'), reason: z.string().min(1) }),
]);
export type ThreadResolutionOutput = z.infer<typeof ThreadResolutionOutputSchema>;

type ReviewerAgentOutput = Output.Output<
  ThreadResolutionOutput,
  DeepPartial<ThreadResolutionOutput>,
  never
>;

export type ReviewerAgent = ToolLoopAgent<never, ReviewerTools, ReviewerAgentOutput>;

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

export const REVIEWER_SYSTEM_PREFIX = [
  '',
  'You are the Reviewer subagent. You receive ONE unresolved PR review thread at a time and',
  'decide between three outcomes, emitting a ThreadResolutionOutput JSON that names the choice.',
  '',
  '- "fixed": the reviewer is right and a code change is needed. Use readFile/writeFile/bash to',
  '  make the fix inside the worktree. DO NOT run `git commit` yourself — the runner commits',
  '  every staged change after you finish. Reply on the thread via the github tool explaining',
  '  the fix and resolve the thread, then emit { kind: "fixed", commitMessage } where',
  '  commitMessage is the subject line the runner will pass to `git commit`.',
  '- "replied": the comment is a question or clarification request and no code change is needed.',
  '  Answer it via github.replyToThread. Do not edit code. Emit { kind: "replied" }.',
  '- "wontfix": the suggestion is stale, out of scope, or you disagree. Reply with the reason',
  '  via github.replyToThread, resolve the thread via github.resolveThread, and emit',
  '  { kind: "wontfix", reason }.',
  '',
  'Rules:',
  '- Stay inside the worktree. No work outside the repo.',
  '- Resolve the thread for "fixed" and "wontfix" outcomes; "replied" leaves it open.',
  '- Return JSON that matches the ThreadResolutionOutput schema exactly.',
].join('\n');

// Module-private link from agent to its init so runReviewer can drive bash commits with the
// same tools without exposing them on the public agent surface (worker uses the same pattern).
const reviewerInitRegistry = new WeakMap<ReviewerAgent, SubagentInit<ReviewerTools>>();

export function createReviewerAgent(init: SubagentInit<ReviewerTools>): ReviewerAgent {
  const agent = new ToolLoopAgent<never, ReviewerTools, ReviewerAgentOutput>({
    model: init.model,
    tools: init.tools,
    instructions: init.systemPrompt,
    output: Output.object({
      schema: ThreadResolutionOutputSchema,
      name: 'ThreadResolution',
    }),
    stopWhen: stepCountIs(init.maxSteps ?? 20),
  });
  reviewerInitRegistry.set(agent, init);
  return agent;
}

export async function runReviewer(
  agent: ReviewerAgent,
  input: ReviewerInput,
): Promise<ReviewerResult> {
  const init = reviewerInitRegistry.get(agent);
  if (!init) {
    return {
      kind: 'error',
      error: 'runReviewer called with an agent not built by createReviewerAgent',
    };
  }
  if (input.threads.length === 0) {
    return { kind: 'ok', resolutions: [] };
  }
  try {
    const resolutions: ThreadResolution[] = [];
    for (const thread of input.threads) {
      resolutions.push(await resolveOneThread(agent, init, input, thread));
    }
    return { kind: 'ok', resolutions };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveOneThread(
  agent: ReviewerAgent,
  init: SubagentInit<ReviewerTools>,
  input: ReviewerInput,
  thread: ReviewThread,
): Promise<ThreadResolution> {
  const result = await agent.generate({ prompt: buildThreadPrompt(input, thread) });
  const out = result.experimental_output;
  switch (out.kind) {
    case 'fixed': {
      const commitSha = await commitFix(init.tools.bash, input.worktreePath, out.commitMessage);
      return { threadId: thread.id, kind: 'fixed', commitSha };
    }
    case 'replied':
      return { threadId: thread.id, kind: 'replied' };
    case 'wontfix':
      return { threadId: thread.id, kind: 'wontfix', reason: out.reason };
  }
}

function buildThreadPrompt(input: ReviewerInput, thread: ReviewThread): string {
  const lines = [`PR: #${input.pr}`, `Worktree: ${input.worktreePath}`, `Thread id: ${thread.id}`];
  if (thread.path) lines.push(`File: ${thread.path}`);
  lines.push('', 'Conversation:');
  for (const c of thread.comments) {
    lines.push(`  @${c.author}: ${c.body}`);
  }
  lines.push('', 'Decide the outcome, take the action, then emit the ThreadResolutionOutput JSON.');
  return lines.join('\n');
}

async function commitFix(
  bash: Tool<BashInput, BashOutput>,
  worktreePath: string,
  message: string,
): Promise<string> {
  const exec = bash.execute;
  if (typeof exec !== 'function') {
    throw new Error('bash tool is missing an execute function');
  }
  const wt = shQuote(worktreePath);
  await runBash(exec, `git -C ${wt} add -A`);
  await runBash(exec, `git -C ${wt} commit -m ${shQuote(message)}`);
  const sha = await captureBash(exec, `git -C ${wt} rev-parse HEAD`);
  return sha.trim();
}

async function runBash(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  command: string,
): Promise<void> {
  const out = await execBash(exec, command);
  if (out.exitCode !== 0) {
    throw new Error(`bash failed (${out.exitCode}): ${command}\n${out.stderr}`);
  }
}

async function captureBash(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  command: string,
): Promise<string> {
  const out = await execBash(exec, command);
  if (out.exitCode !== 0) {
    throw new Error(`bash failed (${out.exitCode}): ${command}\n${out.stderr}`);
  }
  return out.stdout;
}

async function execBash(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  command: string,
): Promise<BashOutput> {
  const out = await exec({ command }, { toolCallId: `reviewer-bash-${Date.now()}`, messages: [] });
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  return out;
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return v !== null && typeof v === 'object' && Symbol.asyncIterator in (v as object);
}

// POSIX shell-quote: wrap in single quotes, escape embedded single quotes.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

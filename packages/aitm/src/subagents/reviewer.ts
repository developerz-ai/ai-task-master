// docs/subagents.md (Reviewer row), docs/commands/merge-pr.md
// Input: unresolved review threads. Output: per-thread resolution (reply / push fix / mark stale).
// Pushes go through Worker tools (FS write, bash); thread ops via a `github` tool that wraps a
// subset of GitHubClient (replyToThread / resolveThread).
//
// Strategy:
//   - One agent.generate call per thread, scoped to that thread's conversation.
//   - Agent submits a structured ThreadResolutionOutput (via the `submit` tool) for the outcome.
//   - For "fixed", the runner — not the agent — performs the git commit so commit shas are
//     deterministic and observable (worker pattern).
//
// SDK references:
//   chunk-04.md §"ToolLoopAgent"
//   chunk-05.md §"Generating Structured Data"
//   chunk-09.md §"Subagents"

import {
  type BashInput,
  type BashOutput,
  createSubagent,
  formatSubmitIssues,
  runWithSchemaRetry,
} from '@developerz.ai/ai-claude-compat';
import { type Tool, type ToolLoopAgent, tool } from 'ai';
import { z } from 'zod';
import type { ReviewThread } from '../github/schema.ts';
import type { GithubToolInput, GithubToolOutput } from '../tools/github-thread-tool.ts';
import {
  AGENT_STEP_BACKSTOP,
  appendReminderBlock,
  forwardInit,
  prependContextBlock,
  type SubagentInit,
} from './factory.ts';
import { render } from './prompts/templates.ts';
import { discardStrayEdits } from './stray-edits.ts';
import type { WorkerTools } from './worker.ts';

// The Reviewer gets the Worker's full edit/search surface (it pushes fixes) plus a `github`
// tool for replying to and resolving review threads.
export type ReviewerTools = WorkerTools & {
  github: Tool<GithubToolInput, GithubToolOutput>;
};

// Per-thread structured output emitted by the model. A FLAT object (not a discriminatedUnion):
// a discriminated union compiles to JSON-Schema `oneOf`, which several OpenRouter-routed
// providers reject for structured output (`output_config.format.schema: Schema type 'oneOf' is
// not supported` — seen on Anthropic, which is also aitm's default tier). `kind` selects the
// outcome; `commitMessage` is expected for "fixed" and `reason` for "wontfix".
export const ThreadResolutionOutputSchema = z.object({
  kind: z.enum(['fixed', 'replied', 'wontfix']),
  commitMessage: z.string().optional(),
  reason: z.string().optional(),
});
export type ThreadResolutionOutput = z.infer<typeof ThreadResolutionOutputSchema>;

export type ReviewerAgent = ToolLoopAgent<never, ReviewerTools>;

export type ReviewerInput = {
  pr: number;
  threads: ReviewThread[];
  checkoutPath: string;
  styleContents: string;
  // The PR head branch. When set, the runner asserts the working tree is on this branch before it
  // commits a "fixed" thread, so a review fix can never land on the wrong branch under the shared
  // single checkout — worktrees were removed, so all groups mutate one tree (audit 02, DECISION 1).
  // Optional: single-flow callers that don't track the head ref omit it and skip the assertion.
  headBranch?: string;
  // Optional harness context block prepended to each thread's first user message (issue #106).
  contextBlock?: string;
  // Optional trailing `<system-reminder>` (the run's Step N/M position) appended to the END of each
  // thread's first user message, kept out of the cacheable leading prefix (slice 04 §4).
  progressBlock?: string;
};

export type ThreadResolution =
  | { threadId: string; kind: 'fixed'; commitSha: string }
  | { threadId: string; kind: 'replied' }
  | { threadId: string; kind: 'wontfix'; reason: string };

export type ReviewerResult =
  | { kind: 'ok'; resolutions: ThreadResolution[] }
  | { kind: 'blocked'; reason: string }
  // `resolutions` carries whatever the pass completed before it errored — empty for a pre-loop
  // failure, threads 1..N-1 when commitFix throws at thread N — so the caller can still record them.
  | { kind: 'error'; error: string; resolutions: ThreadResolution[] };

export const REVIEWER_SYSTEM_PREFIX = [
  '',
  'You are the Reviewer. You get ONE unresolved PR review thread. Pick exactly one outcome and submit it.',
  '',
  '- "fixed": the comment is right and needs code. Locate (grep/glob/readFile), change',
  '  (editFile/multiEdit/writeFile), reply via `github` explaining the fix, resolve the thread. Submit',
  '  { kind: "fixed", commitMessage } — the subject the harness commits. NEVER run git yourself.',
  '- "replied": a question, no code change. Answer via github.replyToThread, leave the thread open.',
  '  Submit { kind: "replied" }.',
  '- "wontfix": stale, out of scope, or you disagree. Reply with the reason, resolve the thread. Submit',
  '  { kind: "wontfix", reason }. Disagree when the comment is wrong — say why, don\'t silently comply.',
  '',
  'Verify any claim in the comment (API, error, spec, changelog) before acting: `webFetch` a doc URL',
  '(`fetchHtml` when available); `datetime` for the current time.',
].join('\n');

// Reviewer step budget — single-sourced so the step-budget reminder (issue #105) and the actual
// createSubagent cap stay in lockstep.
export const REVIEWER_MAX_STEPS = AGENT_STEP_BACKSTOP;

// Module-private link from agent to its init so runReviewer can drive bash commits with the
// same tools without exposing them on the public agent surface (worker uses the same pattern).
const reviewerInitRegistry = new WeakMap<ReviewerAgent, SubagentInit<ReviewerTools>>();

export function createReviewerAgent(init: SubagentInit<ReviewerTools>): ReviewerAgent {
  const agent = createSubagent<ReviewerTools>(
    {
      model: init.model,
      tools: init.tools,
      systemPrompt: init.systemPrompt,
      submit: tool({
        description:
          'Submit the resolution for this review thread (the ThreadResolutionOutput schema).',
        inputSchema: ThreadResolutionOutputSchema,
        execute: async (resolution) => resolution,
      }),
      ...forwardInit(init),
    },
    REVIEWER_MAX_STEPS,
  );
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
      resolutions: [],
    };
  }
  if (input.threads.length === 0) {
    return { kind: 'ok', resolutions: [] };
  }
  // Declared outside the try so a mid-pass throw still surfaces the resolutions gathered before it.
  const resolutions: ThreadResolution[] = [];
  try {
    for (const thread of input.threads) {
      resolutions.push(await resolveOneThread(agent, init, input, thread));
      // Restore a clean tree between threads. A 'replied'/'wontfix' thread's agent still holds the
      // edit/write tools and can leave uncommitted edits behind; without this, the NEXT thread's
      // `git add -A` fix commit would sweep those strays in (commitFix stages the whole tree, not a
      // path list). A committed 'fixed' thread already left a clean tree, so this is a cheap status
      // no-op there. Also leaves the tree clean for the caller's post-pass rebase (take-over-flow).
      await discardStrayEdits(init.tools.bash, input.checkoutPath);
    }
    return { kind: 'ok', resolutions };
  } catch (err) {
    // commitFix's wrong-branch refusal (or a genuine git failure) aborts the pass, but the earlier
    // threads were already replied/resolved on GitHub. Return them so the caller records them as
    // addressed — otherwise a resume re-feeds those threads and duplicates the work (durability #4).
    return { kind: 'error', error: err instanceof Error ? err.message : String(err), resolutions };
  }
}

async function resolveOneThread(
  agent: ReviewerAgent,
  init: SubagentInit<ReviewerTools>,
  input: ReviewerInput,
  thread: ReviewThread,
): Promise<ThreadResolution> {
  const submitted = await runWithSchemaRetry(
    agent,
    ThreadResolutionOutputSchema,
    buildThreadPrompt(input, thread),
    { ...(init.onUsage ? { onUsage: init.onUsage } : {}) },
  );
  if (!submitted.ok) {
    // After the retry kernel exhausts, leave THIS thread for a human as wontfix — never throw, so
    // one thread's bad submission doesn't abort the remaining threads (or discard resolutions
    // already completed this pass). Distinguish the two failure modes in the reason.
    const reason =
      submitted.reason === 'invalid'
        ? `reviewer resolution failed schema validation after retries: ${formatSubmitIssues(submitted.issues)}`
        : 'reviewer did not submit a resolution after retries';
    return { threadId: thread.id, kind: 'wontfix', reason };
  }
  const out = submitted.value;
  switch (out.kind) {
    case 'fixed': {
      // commitMessage is optional on the flat schema; fall back to a generic subject.
      const message = out.commitMessage?.trim() || `fix: address review thread ${thread.id}`;
      const commitSha = await commitFix(
        init.tools.bash,
        input.checkoutPath,
        message,
        input.headBranch,
      );
      if (commitSha === null) {
        // Empty staged index: the model claimed a fix but wrote no code (net-zero or no-op edit).
        // Downgrade to wontfix so we neither push a phantom commit nor report a fix that never
        // landed — the agent already replied/resolved this thread, so wontfix (also "resolved")
        // matches its GitHub state; the reason keeps the no-op observable in the resolution counts.
        return {
          threadId: thread.id,
          kind: 'wontfix',
          reason: 'reviewer reported a fix but staged no changes; nothing to commit',
        };
      }
      return { threadId: thread.id, kind: 'fixed', commitSha };
    }
    case 'replied':
      return { threadId: thread.id, kind: 'replied' };
    default:
      return {
        threadId: thread.id,
        kind: 'wontfix',
        reason: out.reason?.trim() || 'no reason provided',
      };
  }
}

// Trusted framing (coordinates + the decide-act-submit ask) as the `context` slot; the external
// review conversation as the `comment` slot, auto-fenced by render() as <review-comment> so a hostile
// comment body ("ignore previous instructions") is quoted as data, never obeyed. Both author and body
// come from GitHub, so the whole conversation is untrusted and goes inside the fence.
function buildThreadPrompt(input: ReviewerInput, thread: ReviewThread): string {
  const context = [
    `PR: #${input.pr}`,
    `Checkout: ${input.checkoutPath}`,
    `Thread id: ${thread.id}`,
  ];
  if (thread.path) context.push(`File: ${thread.path}`);
  context.push(
    '',
    'Decide the outcome, take the action, then call submit with the ThreadResolutionOutput.',
  );
  const comment = thread.comments.map((c) => `@${c.author}: ${c.body}`).join('\n');
  const prompt = render('review-thread', { context: context.join('\n'), comment });
  return appendReminderBlock(prependContextBlock(input.contextBlock, prompt), input.progressBlock);
}

// Returns the commit sha, or `null` when the staged index is empty (a no-op "fixed"). Genuine git
// failures and the wrong-branch safety refusal still throw — they abort the pass rather than
// silently downgrading, so a fix is never dropped while its thread stays resolved on GitHub.
async function commitFix(
  bash: Tool<BashInput, BashOutput>,
  checkoutPath: string,
  message: string,
  headBranch?: string,
): Promise<string | null> {
  const exec = bash.execute;
  if (typeof exec !== 'function') {
    throw new Error('bash tool is missing an execute function');
  }
  const wt = shQuote(checkoutPath);
  // The runner commits on whatever branch is checked out. Under the shared single checkout that MUST
  // be the PR head branch, so assert it before staging — a review fix silently committed to a
  // concurrent group's branch would be lost or corrupt the wrong PR (audit 02, DECISION 1). This
  // refuses rather than switching branches under uncommitted edits; the clean-tree gate at the next
  // checkout boundary (in-place-checkout.ts) drops any edits stranded by the refusal.
  if (headBranch !== undefined) {
    const current = (await captureBash(exec, `git -C ${wt} rev-parse --abbrev-ref HEAD`)).trim();
    if (current !== headBranch) {
      throw new Error(
        `reviewer refusing to commit: working tree is on '${current}', expected PR head '${headBranch}'`,
      );
    }
  }
  // Stage the whole tree, then unstage aitm's own state dir (in-place mode keeps it at the repo root):
  // add -A skips it when gitignored; the reset drops it when it isn't. See stageAndCommit in worker.ts.
  // The tree holds only THIS thread's edits — runReviewer discards any prior thread's strays between
  // threads (stray-edits.ts) — so add -A cannot sweep another thread's leftovers into this fix commit.
  await runBash(exec, `git -C ${wt} add -A`);
  await runBash(exec, `git -C ${wt} reset -q -- .ai-task-master`);
  // Guard the commit: `git commit` on an empty index exits non-zero ("nothing to commit"), which
  // pre-guard threw and — under the pass-wide try/catch — discarded every resolution gathered this
  // pass (audit 03). Probe the index first; an empty one means no code landed, so return null and
  // let the caller downgrade instead of committing.
  if (await stagedIndexIsEmpty(exec, wt)) {
    return null;
  }
  await runBash(exec, `git -C ${wt} commit -m ${shQuote(message)}`);
  const sha = await captureBash(exec, `git -C ${wt} rev-parse HEAD`);
  return sha.trim();
}

// `git diff --cached --quiet` is the emptiness probe: exit 0 = nothing staged, exit 1 = staged
// changes present. Exit 1 is the expected "has changes" signal, not a failure, so this can't go
// through runBash (which throws on any non-zero); anything above 1 is a real git error and rethrows.
async function stagedIndexIsEmpty(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  wt: string,
): Promise<boolean> {
  const command = `git -C ${wt} diff --cached --quiet`;
  const out = await execBash(exec, command);
  if (out.exitCode === 0) return true;
  if (out.exitCode === 1) return false;
  throw new Error(`bash failed (${out.exitCode}): ${command}\n${out.stderr}`);
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
  const out = await exec(
    { command, description: 'reviewer commit step' },
    { toolCallId: `reviewer-bash-${Date.now()}`, messages: [] },
  );
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

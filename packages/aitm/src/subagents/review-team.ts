// The review side's team: a lead splits the unresolved threads, investigators work them out in
// parallel, and the Reviewer then resolves each one already knowing what it is dealing with.
//
// Reviewing is the one phase where the team CANNOT simply fan out and write. Every "fixed" thread
// ends in `git add -A` + commit against the shared single checkout (reviewer.ts commitFix), so two
// reviewers editing at once would sweep each other's half-finished work into one commit. The writes
// have to stay serial — that is a property of the checkout, not a missing feature.
//
// What is parallelizable is everything BEFORE the write: reading the comment against the code,
// finding where the thing it complains about actually lives, and deciding whether it is right. That
// is the slow part of a review pass and it is read-only, so it fans out safely. The lead groups the
// threads (several comments on one file are ONE investigator's work), the wave runs concurrently,
// and each brief is handed to the sequential resolver that does the writing.
//
// SRP: this module owns the lead, the investigators, and the brief they produce. reviewer.ts still
// owns resolution, commits, and every GitHub side effect — nothing here writes anything.

import { createSubagent, runPool, runWithSchemaRetry } from '@developerz.ai/ai-claude-compat';
import { tool } from 'ai';
import { z } from 'zod';
import { SUBAGENT_LIMIT_DEFAULT } from '../domain/subagent-limit.ts';
import type { ReviewThread } from '../github/schema.ts';
import { AGENT_STEP_BACKSTOP, forwardInit } from './factory.ts';
import type { PlannerTools } from './planner.ts';
import type { ScoutAgentInit } from './planner-scouts.ts';

// Same runaway backstop as every other subagent — these end by submitting, not by running out.
export const REVIEW_TEAM_MAX_STEPS = AGENT_STEP_BACKSTOP;

// Ceiling on one investigation wave, enforced in the lead's schema. The lead picks the real number
// from the threads themselves; this only stops a runaway dispatch.
export const REVIEW_MAX_ASSIGNMENTS = SUBAGENT_LIMIT_DEFAULT;

// One investigator's assignment: the threads it owns and how to go at them. Threads are grouped, not
// dealt one-per-agent — three comments on one file are one investigator's job, and splitting them
// would have three agents read the same file to answer three halves of the same question.
export const ReviewAssignmentSchema = z.object({
  // Short label naming the area, used in progress lines (`auth-middleware`, `error-handling`).
  key: z.string().min(1),
  // The thread ids this investigator owns. Ids not present in the pass are dropped by the caller.
  threadIds: z.array(z.string().min(1)).min(1).max(20),
  // What the investigator must settle for these threads, in the lead's own words.
  question: z.string().min(1),
  // Where to start, what to read whole, what to grep — the same briefing the scout lead gives, for
  // the same reason: the lead has read the comments, the investigator has not.
  startPaths: z.array(z.string()).max(8).default([]),
  mustRead: z.array(z.string()).max(12).default([]),
  searchTerms: z.array(z.string()).max(12).default([]),
});
export type ReviewAssignment = z.infer<typeof ReviewAssignmentSchema>;

export const ReviewPlanSchema = z.object({
  assignments: z.array(ReviewAssignmentSchema).max(REVIEW_MAX_ASSIGNMENTS).default([]),
  rationale: z.string().default(''),
});
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;

// What an investigator returns per thread. Deliberately NOT a decision: the resolver still picks
// fixed/replied/wontfix and is the one that has to defend it. This is the groundwork — where the
// code is and whether the comment holds up against it.
export const ThreadBriefSchema = z.object({
  threadId: z.string().min(1),
  // What the comment is actually asking for, in one or two sentences.
  summary: z.string().min(1),
  // What the code shows, anchored to file:line. The whole point of the pass.
  facts: z.array(z.string()).max(8).default([]),
  // Where the resolver should go. Saves it re-deriving the location the investigator just found.
  relevantPaths: z.array(z.string()).max(8).default([]),
  // Does the comment hold up? A read-only opinion with its reasoning, never a verdict the resolver
  // is bound by — a reviewer that inherits a conclusion it did not reach stops checking the code.
  assessment: z.enum(['valid', 'invalid', 'unclear']).default('unclear'),
  // Why that assessment. Required in practice by the prompt: an assessment with no reasoning is
  // exactly the thing the resolver must not take on trust.
  reasoning: z.string().default(''),
});
export type ThreadBrief = z.infer<typeof ThreadBriefSchema>;

export const InvestigationSchema = z.object({
  briefs: z.array(ThreadBriefSchema).max(20).default([]),
});

export const REVIEW_LEAD_SYSTEM_PREFIX = [
  'You are the review lead. Unresolved review threads have landed on a PR, and one Reviewer will',
  'work through them one at a time — it has to, because every fix it commits touches a shared',
  'checkout. Your job is to send a read-only investigation team ahead of it, so that Reviewer starts',
  'each thread already knowing where the code is and whether the comment holds up.',
  '',
  'You have the read-only tools for a quick look. Do not investigate the threads yourself — that is',
  'what the team is for, and anything you settle alone was settled sequentially.',
  '',
  'Then call submit with the wave.',
].join('\n');

export const REVIEW_INVESTIGATOR_SYSTEM_PREFIX = [
  'You are a read-only investigator on a review team. You own a set of PR review comments and must',
  'work out, against the real code, what each one is actually about and whether it holds up.',
  '',
  'You never write, edit, commit, or reply — a Reviewer does all of that after you, and it decides',
  'the outcome. You are what makes its decision an informed one.',
  '',
  'Ground every claim in the code: readFile, grep, glob (and `explore` for broad questions). Anchor',
  'what you report to file:line. A comment that is simply wrong is a valuable finding — say so and',
  'say why. So is one you could not settle: mark it unclear rather than guessing.',
  '',
  'Submit one brief per thread you were assigned, keyed by its thread id.',
].join('\n');

// Everything the lead and its investigators need. Same dial set as a scout's: same read-only tools,
// same model, same run-scoped cancellation — so the adapter wires all three from one place.
export type ReviewTeamInit = ScoutAgentInit;

export type ReviewLeadRunner = (threads: readonly ReviewThread[]) => Promise<ReviewAssignment[]>;
export type ReviewInvestigatorRunner = (
  assignment: ReviewAssignment,
  threads: readonly ReviewThread[],
) => Promise<ThreadBrief[]>;

// One thread as the lead and investigators see it: id, file, and the conversation so far.
function renderThread(thread: ReviewThread): string {
  const lines = [`- id: ${thread.id}`];
  if (thread.path) lines.push(`  file: ${thread.path}`);
  for (const comment of thread.comments) lines.push(`  @${comment.author}: ${comment.body}`);
  return lines.join('\n');
}

export function buildReviewLeadPrompt(threads: readonly ReviewThread[]): string {
  return [
    `${threads.length} unresolved review thread(s) on this PR:`,
    '',
    ...threads.map(renderThread),
    '',
    `Split them across at most ${REVIEW_MAX_ASSIGNMENTS} read-only investigators — as many as the`,
    'threads genuinely need and no more. Group by what shares GROUND, not by count: several comments',
    'about one file, one module, or one underlying mistake are ONE investigator, because whoever',
    'reads that code answers all of them on the same pass. Two investigators over the same file is',
    'one wasted investigator.',
    '',
    'An investigator is not rationed — it reads as much as its threads need — so a big group is fine',
    'when the ground is shared. Split only where the threads are genuinely about different code.',
    '',
    'Brief each one: the question it must settle, plus startPaths / mustRead / searchTerms so it does',
    'not re-derive what you can already see from the comments. Those are starting points, not limits.',
    '',
    'If these threads need no investigation — they are trivial, or purely conversational — submit an',
    'EMPTY assignments list. The Reviewer will handle them directly, and that is a normal outcome.',
  ].join('\n');
}

export function buildInvestigatorPrompt(
  assignment: ReviewAssignment,
  threads: readonly ReviewThread[],
): string {
  const owned = threads.filter((t) => assignment.threadIds.includes(t.id));
  return [
    `Your assignment: ${assignment.question}`,
    '',
    `The ${owned.length} review thread(s) you own:`,
    '',
    ...owned.map(renderThread),
    '',
    ...(assignment.startPaths.length > 0 ? [`Start in: ${assignment.startPaths.join(', ')}`] : []),
    ...(assignment.mustRead.length > 0 ? [`Read IN FULL: ${assignment.mustRead.join(', ')}`] : []),
    ...(assignment.searchTerms.length > 0
      ? [`Grep for: ${assignment.searchTerms.join(', ')}`]
      : []),
    '',
    'Those are starting points, not limits — read whatever the threads actually lead you to, and',
    'correct your lead where it pointed you wrong.',
    '',
    'For EACH thread id above, submit a brief: what the comment is asking for, what the code actually',
    'shows (file:line), where the Reviewer should go, and whether the comment holds up — valid,',
    'invalid, or unclear — with your reasoning. Never guess a verdict to avoid saying unclear.',
  ].join('\n');
}

export function createReviewLeadRunner(init: ReviewTeamInit): ReviewLeadRunner {
  return async (threads) => {
    const agent = buildTeamAgent(init, 'Submit the investigation wave (the ReviewPlan schema).', {
      schema: ReviewPlanSchema,
    });
    const submitted = await runWithSchemaRetry(
      agent,
      ReviewPlanSchema,
      buildReviewLeadPrompt(threads),
      init.onUsage ? { onUsage: init.onUsage } : {},
    );
    if (!submitted.ok) return [];
    // Only threads actually in this pass: a lead that invents or misremembers an id would otherwise
    // send an investigator after a thread nobody can resolve.
    const known = new Set(threads.map((t) => t.id));
    return submitted.value.assignments
      .map((a) => ({ ...a, threadIds: a.threadIds.filter((id) => known.has(id)) }))
      .filter((a) => a.threadIds.length > 0);
  };
}

export function createReviewInvestigatorRunner(init: ReviewTeamInit): ReviewInvestigatorRunner {
  return async (assignment, threads) => {
    const agent = buildTeamAgent(init, 'Submit one brief per assigned thread.', {
      schema: InvestigationSchema,
    });
    const submitted = await runWithSchemaRetry(
      agent,
      InvestigationSchema,
      buildInvestigatorPrompt(assignment, threads),
      init.onUsage ? { onUsage: init.onUsage } : {},
    );
    if (!submitted.ok) return [];
    const owned = new Set(assignment.threadIds);
    return submitted.value.briefs.filter((b) => owned.has(b.threadId));
  };
}

function buildTeamAgent(
  init: ReviewTeamInit,
  description: string,
  { schema }: { schema: z.ZodType },
) {
  return createSubagent<PlannerTools>(
    {
      model: init.model,
      tools: init.tools(),
      systemPrompt: init.systemPrompt,
      submit: tool({
        description,
        inputSchema: schema,
        execute: async (value: unknown) => value,
      }),
      ...forwardInit<PlannerTools>(init),
    },
    REVIEW_TEAM_MAX_STEPS,
  );
}

// Run the wave and collect every brief, keyed by thread. Best-effort in the same way the scout survey
// is: a dead investigator drops its own threads and the Reviewer resolves those from zero, exactly as
// it did before this module existed. The first brief for a thread wins — a lead that assigned one
// thread twice gets one answer, not a silently overwritten one.
export async function investigateThreads(
  assignments: readonly ReviewAssignment[],
  threads: readonly ReviewThread[],
  runInvestigator: ReviewInvestigatorRunner,
  concurrency: number = SUBAGENT_LIMIT_DEFAULT,
): Promise<Map<string, ThreadBrief>> {
  const waves = await runPool([...assignments], concurrency, async (assignment) =>
    runInvestigator(assignment, threads).catch(() => []),
  );
  const briefs = new Map<string, ThreadBrief>();
  for (const brief of waves.flat()) {
    if (!briefs.has(brief.threadId)) briefs.set(brief.threadId, brief);
  }
  return briefs;
}

// The brief as the resolving Reviewer reads it. Framed as groundwork it must confirm, never as a
// verdict: the Reviewer is the one that replies to a human and commits code, so it has to have
// looked at the same lines itself.
export function renderThreadBrief(brief: ThreadBrief): string {
  const lines = [
    '<investigation>',
    'A read-only investigator looked at this thread before you. Leads, not conclusions — you decide',
    'the outcome, and you confirm anything you act on.',
    '',
    brief.summary.trim(),
  ];
  for (const fact of brief.facts.map((f) => f.trim()).filter((f) => f !== '')) {
    lines.push(`- ${fact}`);
  }
  const paths = brief.relevantPaths.map((p) => p.trim()).filter((p) => p !== '');
  if (paths.length > 0) lines.push(`relevant: ${paths.join(', ')}`);
  const reasoning = brief.reasoning.trim();
  lines.push(
    `assessment: the comment looks ${brief.assessment}${reasoning === '' ? '' : ` — ${reasoning}`}`,
  );
  lines.push('</investigation>');
  return lines.join('\n');
}

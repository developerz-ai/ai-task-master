// The adapter half of the review team (subagents/review-team.ts): build the read-only lead and
// investigators from a RunLoopInput, run the wave, and hand back one rendered brief per thread.
//
// Split out of run-loop-adapter.ts for the same reason planner-wiring.ts was: this is the only place
// that turns run configuration into a concrete read-only agent init for the review side, and the
// adapter's reviewer path is already long enough without a second team's construction inlined in it.

import type { RunLoopInput } from '../composition/run-input.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { McpClientManager } from '../mcp/mcp-client.ts';
import type { StepCounter } from '../observability/run-step.ts';
import { harnessProgress } from '../observability/step-progress.ts';
import type { OnUsage } from '../subagents/factory.ts';
import type { ScoutAgentInit } from '../subagents/planner-scouts.ts';
import {
  createReviewInvestigatorRunner,
  createReviewLeadRunner,
  investigateThreads,
  REVIEW_INVESTIGATOR_SYSTEM_PREFIX,
  REVIEW_LEAD_SYSTEM_PREFIX,
  renderThreadBrief,
} from '../subagents/review-team.ts';
import { reminderAgentSystemPrompt } from '../subagents/role-prompt.ts';
import { buildExploreFor, decorateTools, resolvePlannerTools } from './tool-resolution.ts';

export type InvestigateReviewThreadsParams = {
  input: RunLoopInput;
  threads: readonly ReviewThread[];
  // The shared single checkout the PR is on. The team is read-only, so this only roots its read
  // tools — nothing here may write into it while the resolver is about to commit there.
  checkoutPath: string;
  style: string;
  reviewerModelId: string;
  reviewerUsage?: OnUsage;
  mcp: McpClientManager;
  fetchHtmlAvailable: boolean;
  // The run's Step N/M position, forwarded onto the team's progress lines so they read in the
  // same frame as the reviewer's own. Absent on callers that track no counter.
  counter?: StepCounter | undefined;
};

// Run the investigation wave and return the briefs, rendered for injection into each thread's
// prompt. Best-effort throughout: a lead that dispatches nothing, a dead investigator, or a thrown
// wave all degrade to fewer (or no) briefs, and every thread without one is resolved exactly as it
// was before the team existed. Nothing here may fail the review pass — the threads still need
// answering either way.
export async function investigateReviewThreads(
  params: InvestigateReviewThreadsParams,
): Promise<Map<string, string>> {
  const { input, threads, checkoutPath, style, reviewerModelId, mcp, fetchHtmlAvailable } = params;
  const usage = params.reviewerUsage;
  const progress = { phase: 'reviewing' as const, ...(params.counter ?? {}) };
  // Read-only by construction: the planner tool set (readFile/grep/glob/web/explore), never the
  // Reviewer's edit/bash/github surface. An investigator that could write would be a second writer
  // in the shared checkout, which is the one thing this design exists to avoid.
  const readTools = decorateTools(
    resolvePlannerTools(
      mcp.toolsForRole('reviewer'),
      checkoutPath,
      fetchHtmlAvailable,
      buildExploreFor(input, checkoutPath, usage),
    ),
    input,
    checkoutPath,
  );
  const teamInit = (roleGuidance: string): ScoutAgentInit => ({
    model: input.credentials.modelFor('reviewer'),
    tools: readTools,
    systemPrompt: reminderAgentSystemPrompt({
      style,
      roleGuidance,
      cwd: checkoutPath,
      modelId: reviewerModelId,
    }),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(usage ? { onUsage: usage } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const assignments = await createReviewLeadRunner(teamInit(REVIEW_LEAD_SYSTEM_PREFIX))(
    threads,
  ).catch(() => []);
  if (assignments.length === 0) return new Map();
  harnessProgress(
    `review team: ${assignments.length} investigator(s) on ${assignments.map((a) => a.key).join(', ')}`,
    progress,
  );
  const briefs = await investigateThreads(
    assignments,
    threads,
    createReviewInvestigatorRunner(teamInit(REVIEW_INVESTIGATOR_SYSTEM_PREFIX)),
    input.resolved.subagentLimit,
  ).catch(() => new Map());
  harnessProgress(`review team: ${briefs.size}/${threads.length} thread(s) investigated`, progress);
  return new Map([...briefs].map(([threadId, brief]) => [threadId, renderThreadBrief(brief)]));
}

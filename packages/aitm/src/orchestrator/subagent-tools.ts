// Wrap each subagent as a tool consumable by the Orchestrator agent.
// Pattern verbatim from docs/vendor/ai-sdk/chunk-09.md §"Subagents" and §"Controlling What the
// Model Sees" — `toModelOutput` keeps the Orchestrator context lean by collapsing the full
// subagent result to a one-line `<role> [<status>]: <summary>`.
//
// Note: AI SDK 6 names the field `toModelOutput` (the SDK-5 name was
// `experimental_toToolResultContent`; the task brief uses the older spelling).
//
// Each wrapper:
//   - inputSchema  — Zod schema; the Orchestrator's model fills it in per call
//   - execute      — builds the subagent via its factory using `credentials.modelFor(role)` and
//                    runs the matching runner; returns the full structured result
//   - toModelOutput — collapses that result to a single status line for the Orchestrator

import type { LanguageModel, Tool } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import type { Role } from '../credentials/credentials.ts';
import type { ReviewThread } from '../github/schema.ts';
import type { PrGroup } from '../state/schema.ts';
import type { OnUsage, SubagentInit } from '../subagents/factory.ts';
import {
  createPlannerAgent,
  PLANNER_MAX_STEPS,
  PLANNER_SYSTEM_PREFIX,
  type PlannerResult,
  type PlannerTools,
  runPlanner,
} from '../subagents/planner.ts';
import {
  createReviewerAgent,
  REVIEWER_MAX_STEPS,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerResult,
  type ReviewerTools,
  runReviewer,
} from '../subagents/reviewer.ts';
import { buildRolePrompt } from '../subagents/role-prompt.ts';
import {
  createWorkerAgent,
  runWorker,
  WORKER_MAX_STEPS,
  WORKER_SYSTEM_PREFIX,
  type WorkerResult,
  type WorkerTools,
} from '../subagents/worker.ts';

// Minimal model-resolver surface. The concrete `Credentials` class is structurally compatible;
// tests substitute a `{ modelFor }` literal so they don't need to construct the real provider.
export type ModelProvider = { modelFor(role: Role): LanguageModel };

type CommonDeps = {
  credentials: ModelProvider;
  // Coding-style payload (CLAUDE.md/AGENTS.md contents) fed to every subagent's role prompt.
  styleContents: string;
  // Rolling summary of prior PRs in this run, threaded into Worker/Reviewer prompts.
  rollingContext: string;
  // Checkout cwd for each subagent's `<env>` block (buildRolePrompt reads it). All three subagents
  // operate in the same checkout, so it lives on the shared base.
  checkoutPath: string;
};

export type PlannerToolDeps = CommonDeps & {
  plannerTools: PlannerTools;
};

export type WorkerToolDeps = CommonDeps & {
  workerTools: WorkerTools;
  baseBranch: string;
  group: PrGroup;
  // Optional Worker config mirrored from the direct run-loop spawn path (run-loop-adapter's
  // `createWorkerAgent`/`runWorker`) so the orchestrator-as-tool Worker is configured identically —
  // no config drift. Each is forwarded conditionally in makeWorkerTool, the same idiom the direct
  // path uses. Types are indexed off SubagentInit so they can't drift from what createWorkerAgent
  // accepts. Per-commit `verifyCommand` is deliberately NOT threaded here: the orchestrator-tool
  // Worker plans across the whole group, and the verify gate belongs to the per-task direct path.
  formatCommand?: string;
  providerOptions?: SubagentInit<WorkerTools>['providerOptions'];
  timeout?: SubagentInit<WorkerTools>['timeout'];
  onUsage?: OnUsage;
};

export type ReviewerToolDeps = CommonDeps & {
  reviewerTools: ReviewerTools;
  pr: number;
  threads: ReviewThread[];
};

// Legacy aggregate retained as a convenience for orchestrator wiring; individual factories
// only consume their per-role slice.
export type SubagentToolDeps = PlannerToolDeps & WorkerToolDeps & ReviewerToolDeps;

const plannerInputSchema = z.object({
  goal: z.string().min(1).describe('User goal to plan PR groups for'),
  criteria: z.string().optional().describe('Optional acceptance criteria'),
  maxPrs: z.number().int().positive().describe('Cap on PR-group count'),
});
type PlannerToolInput = z.infer<typeof plannerInputSchema>;

// Worker + Reviewer have all state bound in deps — the Orchestrator's model invokes them with
// no arguments, signalling "process the currently-active group / review threads".
const emptyInputSchema = z.object({});
type EmptyInput = z.infer<typeof emptyInputSchema>;

export function makePlannerTool(deps: PlannerToolDeps): Tool<PlannerToolInput, PlannerResult> {
  return tool<PlannerToolInput, PlannerResult>({
    description:
      'Run the Planner subagent. Given a goal, returns an ordered DAG of PR groups; each group is a single cohesive pull request.',
    inputSchema: plannerInputSchema,
    execute: async (input): Promise<PlannerResult> => {
      const agent = createPlannerAgent({
        model: deps.credentials.modelFor('planner'),
        tools: deps.plannerTools,
        systemPrompt: buildRolePrompt({
          style: deps.styleContents,
          roleGuidance: PLANNER_SYSTEM_PREFIX,
          cwd: deps.checkoutPath,
        }),
      });
      return runPlanner(agent, {
        goal: input.goal,
        styleContents: deps.styleContents,
        maxPrs: input.maxPrs,
        ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
      });
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: summarizePlannerResult(output) }),
  });
}

export function makeWorkerTool(deps: WorkerToolDeps): Tool<EmptyInput, WorkerResult> {
  return tool<EmptyInput, WorkerResult>({
    description:
      'Run the Worker subagent on the active PR group. Produces a file manifest, fans out per-file editors, commits on the group branch.',
    inputSchema: emptyInputSchema,
    execute: async (): Promise<WorkerResult> => {
      const agent = createWorkerAgent({
        model: deps.credentials.modelFor('worker'),
        tools: deps.workerTools,
        systemPrompt: buildRolePrompt({
          style: deps.styleContents,
          roleGuidance: WORKER_SYSTEM_PREFIX,
          cwd: deps.checkoutPath,
        }),
        // Same optional Worker config the direct run-loop path forwards — conditionally spread so an
        // unset dep never overrides a factory default under exactOptionalPropertyTypes.
        ...(deps.timeout !== undefined ? { timeout: deps.timeout } : {}),
        ...(deps.providerOptions !== undefined ? { providerOptions: deps.providerOptions } : {}),
        ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
      });
      return runWorker(agent, {
        group: deps.group,
        checkoutPath: deps.checkoutPath,
        baseBranch: deps.baseBranch,
        styleContents: deps.styleContents,
        rollingContext: deps.rollingContext,
        // formatCommand mirrors the direct path; verifyCommand stays off by design (see WorkerToolDeps).
        ...(deps.formatCommand ? { formatCommand: deps.formatCommand } : {}),
      });
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: summarizeWorkerResult(output) }),
  });
}

export function makeReviewerTool(deps: ReviewerToolDeps): Tool<EmptyInput, ReviewerResult> {
  return tool<EmptyInput, ReviewerResult>({
    description:
      'Run the Reviewer subagent on outstanding PR review threads. Each thread resolves to fixed / replied / wontfix.',
    inputSchema: emptyInputSchema,
    execute: async (): Promise<ReviewerResult> => {
      const agent = createReviewerAgent({
        model: deps.credentials.modelFor('reviewer'),
        tools: deps.reviewerTools,
        systemPrompt: buildRolePrompt({
          style: deps.styleContents,
          roleGuidance: REVIEWER_SYSTEM_PREFIX,
          cwd: deps.checkoutPath,
        }),
      });
      return runReviewer(agent, {
        pr: deps.pr,
        threads: deps.threads,
        checkoutPath: deps.checkoutPath,
        styleContents: deps.styleContents,
      });
    },
    toModelOutput: ({ output }) => ({ type: 'text', value: summarizeReviewerResult(output) }),
  });
}

// Cap per-line summary length so a verbose subagent reply (long IDs, multiline draft
// commit messages, error payloads) can't bloat the orchestrator's context. 220 chars
// is enough for a status line + a few tens of chars of free text.
const MAX_SUMMARY_CHARS = 220;
// Show only the first N planner group IDs, then `+M more` — the count alone is what
// matters to the orchestrator; the orchestrator can re-read the plan if it needs the
// full ID list.
const MAX_PREVIEW_IDS = 8;

function compactOneLine(text: string, max = MAX_SUMMARY_CHARS): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function summarizePlannerResult(r: PlannerResult): string {
  if (r.kind === 'ok') {
    const ids = r.plan.groups.map((g) => g.id);
    const preview = ids.slice(0, MAX_PREVIEW_IDS).join(', ');
    const suffix = ids.length > MAX_PREVIEW_IDS ? `, +${ids.length - MAX_PREVIEW_IDS} more` : '';
    return compactOneLine(`planner [ok]: ${r.plan.groups.length} group(s) — ${preview}${suffix}`);
  }
  if (r.kind === 'blocked') return compactOneLine(`planner [blocked]: ${r.reason}`);
  return compactOneLine(`planner [error]: ${r.error}`);
}

function summarizeWorkerResult(r: WorkerResult): string {
  if (r.kind === 'ok') {
    const d = r.delivery;
    return compactOneLine(
      `worker [ok]: ${d.branch} — ${d.draftCommitMessage} (${d.changes.length} file(s))`,
    );
  }
  if (r.kind === 'blocked') return compactOneLine(`worker [blocked]: ${r.reason}`);
  if (r.kind === 'no-changes') return compactOneLine(`worker [no-changes]: ${r.reason}`);
  return compactOneLine(`worker [error]: ${r.error}`);
}

function summarizeReviewerResult(r: ReviewerResult): string {
  if (r.kind === 'ok') {
    const counts = r.resolutions.reduce<Record<string, number>>((acc, x) => {
      acc[x.kind] = (acc[x.kind] ?? 0) + 1;
      return acc;
    }, {});
    const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`);
    const tail = parts.length > 0 ? ` — ${parts.join(', ')}` : '';
    return compactOneLine(`reviewer [ok]: ${r.resolutions.length} resolution(s)${tail}`);
  }
  if (r.kind === 'blocked') return compactOneLine(`reviewer [blocked]: ${r.reason}`);
  return compactOneLine(`reviewer [error]: ${r.error}`);
}

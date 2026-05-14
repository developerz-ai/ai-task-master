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

import { generateText, hasToolCall, Output, stepCountIs, ToolLoopAgent } from 'ai';
import { ExecaError, execa } from 'execa';
import { z } from 'zod';
import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import type { CreatePrInput } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import type { PrGroup } from '../state/schema.ts';
import type { PlannerTools } from '../subagents/planner.ts';
import type { ReviewerTools } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerTools } from '../subagents/worker.ts';
import {
  type ModelProvider,
  makePlannerTool,
  makeReviewerTool,
  makeWorkerTool,
} from './subagent-tools.ts';

// Narrow surface — orchestrator only opens PRs, never shells `gh` itself.
// Structural so tests can drop in a literal stub without subclassing GitHubClient.
export type GhClient = {
  createPr(input: CreatePrInput): Promise<PullRequest>;
};

// `git commit --amend` injection seam — defaults to execa so tests can record argv
// without spawning git. Mirrors the GitHubClient.RunCmd shape on purpose.
export type RunCmdOptions = { cwd?: string };
export type RunCmdResult = { stdout: string; stderr: string; exitCode: number };
export type RunCmd = (
  file: string,
  args: readonly string[],
  options?: RunCmdOptions,
) => Promise<RunCmdResult>;

export const defaultRunCmd: RunCmd = async (file, args, options) => {
  try {
    const r = await execa(file, [...args], options?.cwd ? { cwd: options.cwd } : {});
    return {
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      exitCode: r.exitCode ?? 0,
    };
  } catch (err) {
    if (err instanceof ExecaError) {
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : '',
        exitCode: err.exitCode ?? 1,
      };
    }
    throw err;
  }
};

// Inlined per CLAUDE.md "no premature abstraction". Full system prompt is
// `agentConfig.contents + ORCHESTRATOR_ROLE_PREFIX + rollingContext`.
export const ORCHESTRATOR_ROLE_PREFIX = [
  '',
  '## Role: Orchestrator',
  '',
  'You coordinate three subagents — Planner, Worker, Reviewer — each exposed as a tool.',
  'You see the whole plan and the rolling context, so you also own per-PR prose:',
  'the final commit message and the PR title + body.',
  '',
  'Flow:',
  '  1. Call the planner tool once to produce the PR-group DAG.',
  '  2. For each ready group, call the worker tool. The harness then commits + opens the PR.',
  '  3. For each merged PR with unresolved review threads, call the reviewer tool.',
  '  4. Stop when every group is merged or blocked.',
  '',
  'Rules:',
  '  - Be specific and terse. No marketing prose.',
  '  - Conventional commit subjects, ≤72 chars.',
].join('\n');

export type OrchestratorInit = {
  // Structural ModelProvider, not the concrete Credentials class, so tests can pass a literal
  // `{ modelFor }` stub. The real Credentials instance satisfies the shape unchanged.
  credentials: ModelProvider;
  agentConfig: AgentConfig;
  rollingContext: string;
  maxSessions: number | null;
  github: GhClient;
  // Defaults to execa-backed runner. Tests inject a recorder.
  runCmd?: RunCmd;
};

// Per-group state needed to wire the subagent tools. Built fresh for each Orchestrator
// invocation since worktreePath / group / pr / threads vary between groups.
export type OrchestratorBuildContext = {
  plannerTools: PlannerTools;
  workerTools: WorkerTools;
  reviewerTools: ReviewerTools;
  worktreePath: string;
  baseBranch: string;
  group: PrGroup;
  pr: number;
  threads: ReviewThread[];
};

export type OrchestratorTools = {
  planner: ReturnType<typeof makePlannerTool>;
  worker: ReturnType<typeof makeWorkerTool>;
  reviewer: ReturnType<typeof makeReviewerTool>;
};

// Structured-output schema for PR composition. Title cap reinforces conventional-commit
// brevity; body is free-form markdown.
const PrCompositionSchema = z.object({
  title: z.string().min(1).max(72),
  body: z.string().min(1),
});
type PrComposition = z.infer<typeof PrCompositionSchema>;

// Fallback session cap when caller passes null / 0 / negative `maxSessions`.
export const DEFAULT_MAX_STEPS = 50;

// Resolve the agent step cap from caller-provided `maxSessions`. Falls back to the
// default when the value is null, zero, or negative. Exported for unit testing.
export function resolveMaxSteps(maxSessions: number | null): number {
  return typeof maxSessions === 'number' && maxSessions > 0 ? maxSessions : DEFAULT_MAX_STEPS;
}

export class Orchestrator {
  constructor(private readonly init: OrchestratorInit) {}

  build(context: OrchestratorBuildContext): ToolLoopAgent<never, OrchestratorTools> {
    const commonDeps = {
      credentials: this.init.credentials,
      styleContents: this.init.agentConfig.contents,
      rollingContext: this.init.rollingContext,
    };
    const tools: OrchestratorTools = {
      planner: makePlannerTool({ ...commonDeps, plannerTools: context.plannerTools }),
      worker: makeWorkerTool({
        ...commonDeps,
        workerTools: context.workerTools,
        worktreePath: context.worktreePath,
        baseBranch: context.baseBranch,
        group: context.group,
      }),
      reviewer: makeReviewerTool({
        ...commonDeps,
        reviewerTools: context.reviewerTools,
        worktreePath: context.worktreePath,
        pr: context.pr,
        threads: context.threads,
      }),
    };
    return new ToolLoopAgent<never, OrchestratorTools>({
      model: this.init.credentials.modelFor('orchestrator'),
      instructions: this.buildSystemPrompt(),
      tools,
      stopWhen: [stepCountIs(resolveMaxSteps(this.init.maxSessions)), hasToolCall('done')],
    });
  }

  buildSystemPrompt(): string {
    return [
      this.init.agentConfig.contents,
      ORCHESTRATOR_ROLE_PREFIX,
      this.init.rollingContext,
    ].join('\n');
  }

  // Re-write the Worker's draft commit message via the orchestrator model, then
  // `git commit --amend` on the active worktree. Returns the new HEAD SHA.
  async finalizeCommit(
    group: PrGroup,
    delivery: WorkerDelivery,
    worktreePath: string,
  ): Promise<string> {
    const refined = await this.refineCommitMessage(group, delivery);
    const runCmd = this.init.runCmd ?? defaultRunCmd;
    const amend = await runCmd('git', ['commit', '--amend', '-m', refined], { cwd: worktreePath });
    if (amend.exitCode !== 0) {
      throw new Error(`git commit --amend failed: ${amend.stderr.trim() || amend.stdout.trim()}`);
    }
    const sha = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
    if (sha.exitCode !== 0) {
      throw new Error(`git rev-parse HEAD failed: ${sha.stderr.trim() || sha.stdout.trim()}`);
    }
    return sha.stdout.trim();
  }

  // Compose PR title + body via the orchestrator model, then open the PR through the github
  // client. Falls back to `aitm/<group.id>` when `group.branch` is unset.
  async openPr(group: PrGroup, delivery: WorkerDelivery, baseBranch: string): Promise<PullRequest> {
    const { title, body } = await this.composePr(group, delivery);
    const head = group.branch ?? `aitm/${group.id}`;
    return this.init.github.createPr({ title, body, base: baseBranch, head });
  }

  private async refineCommitMessage(group: PrGroup, delivery: WorkerDelivery): Promise<string> {
    const { text } = await generateText({
      model: this.init.credentials.modelFor('orchestrator'),
      prompt: this.buildCommitPrompt(group, delivery),
    });
    return text.trim();
  }

  private buildCommitPrompt(group: PrGroup, delivery: WorkerDelivery): string {
    return [
      this.buildSystemPrompt(),
      '',
      'Rewrite the worker draft into a final commit message.',
      'Subject ≤72 chars, conventional-commit style. Body optional, one paragraph.',
      'Output ONLY the message — no labels, no quotes.',
      '',
      `PR group: ${group.id} — ${group.title}`,
      `Worker draft: ${delivery.draftCommitMessage}`,
      'Files changed:',
      ...delivery.changes.map((c) => `  - ${c.kind} ${c.path}: ${c.summary}`),
    ].join('\n');
  }

  private async composePr(group: PrGroup, delivery: WorkerDelivery): Promise<PrComposition> {
    const result = await generateText({
      model: this.init.credentials.modelFor('orchestrator'),
      prompt: this.buildPrPrompt(group, delivery),
      output: Output.object({ schema: PrCompositionSchema, name: 'PrComposition' }),
    });
    return result.experimental_output;
  }

  private buildPrPrompt(group: PrGroup, delivery: WorkerDelivery): string {
    return [
      this.buildSystemPrompt(),
      '',
      'Compose the pull-request title and body for this PR group. Return JSON.',
      '- title: conventional-commit style, ≤72 chars',
      '- body: short summary + bulleted file changes + relevant rolling context',
      '',
      `PR group: ${group.id} — ${group.title}`,
      `Worker draft message: ${delivery.draftCommitMessage}`,
      'Files changed:',
      ...delivery.changes.map((c) => `  - ${c.kind} ${c.path}: ${c.summary}`),
    ].join('\n');
  }
}

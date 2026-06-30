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

import { submittedOutput } from '@developerz.ai/ai-claude-compat';
import { generateText, hasToolCall, stepCountIs, ToolLoopAgent, tool } from 'ai';
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
  // Distilled coding-style digest. When present it replaces agentConfig.contents as the style
  // prefix for the orchestrator prompt and every subagent tool; absent → raw contents.
  styleDigest?: string;
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

// The required PR body section headings, in order. Single source of truth for both the model
// guidance (PR_BODY_GUIDE) and the post-composition contract check (assertPrBodySections).
export const PR_BODY_SECTIONS = ['## Summary', '## Changes', '## Testing'] as const;

// Enforce the PR body contract: the three sections must all be present, as real markdown heading
// lines, and in order. Throws a descriptive error otherwise, so a malformed body is rejected before
// the PR is opened. Matches against actual `## …` heading lines (not arbitrary substrings) so a
// section name mentioned in prose can't satisfy the check. Exported for unit testing.
export function assertPrBodySections(body: string): void {
  const headingLines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('## '));
  let cursor = -1;
  for (const heading of PR_BODY_SECTIONS) {
    const idx = headingLines.indexOf(heading, cursor + 1);
    if (idx === -1) {
      throw new Error(
        `PR body must contain heading lines ${PR_BODY_SECTIONS.join(', ')} in order; ` +
          `missing or misordered: ${heading}`,
      );
    }
    cursor = idx;
  }
}

// Structured-output schema for PR composition. Title cap reinforces conventional-commit
// brevity; the body's section contract is enforced by assertPrBodySections after submission.
const PrCompositionSchema = z.object({
  title: z.string().min(1).max(72),
  body: z.string().min(1),
});
type PrComposition = z.infer<typeof PrCompositionSchema>;

// Standard PR body every aitm-opened PR follows, so reviewers get a consistent shape. The
// Orchestrator model fills these sections from the worker delivery; exported so the format is
// unit-testable and documented in one place.
export const PR_BODY_GUIDE = [
  'body: GitHub-flavored markdown with exactly these three sections, in order, each with its',
  'heading verbatim:',
  `  ${PR_BODY_SECTIONS[0]}`,
  '    1-2 sentences on what changed and why.',
  `  ${PR_BODY_SECTIONS[1]}`,
  '    Bulleted list of the notable file/area changes.',
  `  ${PR_BODY_SECTIONS[2]}`,
  '    How the change was verified (tests, lint). If not verified, say so explicitly.',
].join('\n');

// Fallback session cap when caller passes null / 0 / negative `maxSessions`.
export const DEFAULT_MAX_STEPS = 50;

// Resolve the agent step cap from caller-provided `maxSessions`. Falls back to the
// default when the value is null, zero, or negative. Exported for unit testing.
export function resolveMaxSteps(maxSessions: number | null): number {
  return typeof maxSessions === 'number' && maxSessions > 0 ? maxSessions : DEFAULT_MAX_STEPS;
}

export class Orchestrator {
  constructor(private readonly init: OrchestratorInit) {}

  // Distilled digest when available, else the raw agent-config contents.
  private styleContents(): string {
    return this.init.styleDigest ?? this.init.agentConfig.contents;
  }

  build(context: OrchestratorBuildContext): ToolLoopAgent<never, OrchestratorTools> {
    const commonDeps = {
      credentials: this.init.credentials,
      styleContents: this.styleContents(),
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
    return [this.styleContents(), ORCHESTRATOR_ROLE_PREFIX, this.init.rollingContext].join('\n');
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
    // Structured output via a forced submit tool (tool-calling) rather than response_format
    // json_schema, which some OpenAI-compatible providers ignore. Single tool + forced choice =
    // one-shot; generateText takes a single step (no stopWhen), so it can't loop on the tool.
    const result = await generateText({
      model: this.init.credentials.modelFor('orchestrator'),
      prompt: this.buildPrPrompt(group, delivery),
      tools: {
        submit: tool({
          description:
            'Submit the composed pull-request title and body (the PrComposition schema).',
          inputSchema: PrCompositionSchema,
          execute: async (composition) => composition,
        }),
      },
      toolChoice: { type: 'tool', toolName: 'submit' },
    });
    const out = submittedOutput(result, PrCompositionSchema);
    if (!out) {
      throw new Error('orchestrator did not submit a PR composition');
    }
    assertPrBodySections(out.body);
    return out;
  }

  private buildPrPrompt(group: PrGroup, delivery: WorkerDelivery): string {
    return [
      this.buildSystemPrompt(),
      '',
      'Compose the pull-request title and body for this PR group, then call the submit tool with it.',
      '- title: conventional-commit style, ≤72 chars, summarizing the PR group goal below.',
      '  Do NOT copy a single commit message — the title describes the whole group, not one task.',
      PR_BODY_GUIDE,
      '',
      `PR group goal (use this as the title's subject): ${group.id} — ${group.title}`,
      `Worker draft message (context for the body only — not the title): ${delivery.draftCommitMessage}`,
      'Files changed:',
      ...delivery.changes.map((c) => `  - ${c.kind} ${c.path}: ${c.summary}`),
    ].join('\n');
  }
}

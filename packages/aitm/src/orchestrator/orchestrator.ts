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

import {
  callWithStepTimeout,
  correctiveMessage,
  formatSubmitIssues,
  type SubmittedOutput,
  submittedOutput,
} from '@developerz.ai/ai-claude-compat';
import {
  generateText,
  hasToolCall,
  type ModelMessage,
  stepCountIs,
  type TimeoutConfiguration,
  type Tool,
  ToolLoopAgent,
  tool,
} from 'ai';
import { ExecaError, execa } from 'execa';
import { z } from 'zod';
import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import type { CreatePrInput } from '../github/github-client.ts';
import type { PullRequest, ReviewThread } from '../github/schema.ts';
import type { PrGroup } from '../state/schema.ts';
import { type OnUsage, reportUsage } from '../subagents/factory.ts';
import type { PlannerTools } from '../subagents/planner.ts';
import { render } from '../subagents/prompts/templates.ts';
import type { ReviewerTools } from '../subagents/reviewer.ts';
import type { WorkerDelivery, WorkerTools } from '../subagents/worker.ts';
import { taskCommitTrailer } from '../workspace/task-commit-marker.ts';
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

// The orchestrator's role guidance. buildSystemPrompt weaves it with the style digest and rolling
// context through render('orchestrator-system', …) — the one prompt-assembly seam, no call-site concat.
export const ORCHESTRATOR_ROLE_PREFIX = [
  '',
  '## Role: Orchestrator',
  '',
  'You coordinate Planner, Worker (Coordinator), and Reviewer, each exposed as a tool. You see the whole',
  'plan and the rolling context, so you own the per-PR prose: the final commit message and the PR title',
  '+ body.',
  '',
  'Flow:',
  '  1. planner → the PR-group DAG (once).',
  '  2. each ready group → worker; the harness commits + opens the PR.',
  '  3. each PR with unresolved threads → reviewer.',
  '  4. stop when every group is merged or blocked.',
  '',
  'Rules:',
  '  - Only you route between subagents; subagents are leaves and never spawn each other.',
  '  - Specific and terse. No marketing prose. Conventional commit subjects, ≤72 chars.',
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
  // LLM step budget for the orchestrator loop (separate from maxSessions, a PR/session count).
  // Null/0/negative → DEFAULT_MAX_STEPS. Caller responsibility to set a sensible value.
  maxSteps: number | null;
  github: GhClient;
  // Optional per-repo PR body section headings (each a `## ` heading). Undefined/empty/malformed
  // falls back to the default Summary/Changes/Testing/Evidence. See resolvePrBodySections.
  prBodySections?: readonly string[];
  // Defaults to execa-backed runner. Tests inject a recorder.
  runCmd?: RunCmd;
  // Per-step LLM request deadline for the two direct generateText sites (commit-message refine, PR
  // compose). Unset → no deadline. Threaded from resolved config as `{ stepMs }`. Issue #129.
  timeout?: TimeoutConfiguration;
  // Usage sink for the two direct generateText sites, recorded under the orchestrator role (#114).
  onUsage?: OnUsage;
  // Harness-level notice sink for the direct generateText sites — currently only composePr's
  // deterministic fallback (`PR composition fell back …`). Injected so the Orchestrator stays free of
  // the observability rendering details; the adapter wires it to harnessProgress. Mirrors `onUsage`.
  onProgress?: (message: string) => void;
};

// Per-group state needed to wire the subagent tools. Built fresh for each Orchestrator
// invocation since checkoutPath / group / pr / threads vary between groups.
export type OrchestratorBuildContext = {
  plannerTools: PlannerTools;
  workerTools: WorkerTools;
  reviewerTools: ReviewerTools;
  checkoutPath: string;
  baseBranch: string;
  group: PrGroup;
  pr: number;
  threads: ReviewThread[];
};

export type OrchestratorTools = {
  planner: ReturnType<typeof makePlannerTool>;
  worker: ReturnType<typeof makeWorkerTool>;
  reviewer: ReturnType<typeof makeReviewerTool>;
  done: Tool<Record<string, never>, Record<string, never>>;
};

// The default PR body section headings, in order. Used when a repo does not configure its own
// via `prBodySections`. Single source of truth for both the model guidance and the assertion.
export const PR_BODY_SECTIONS = ['## Summary', '## Changes', '## Testing', '## Evidence'] as const;

// Resolve the effective section list from optional config. Every entry must be a real `## `
// heading; if the config is empty or any entry is malformed, fall back to the default so a bad
// config never blocks a run. Exported for unit testing.
export function resolvePrBodySections(raw: readonly string[] | undefined): readonly string[] {
  if (raw === undefined || raw.length === 0) return PR_BODY_SECTIONS;
  const cleaned = raw.map((s) => s.trim());
  return cleaned.every((s) => /^##\s+\S/.test(s)) ? cleaned : PR_BODY_SECTIONS;
}

// Enforce the PR body contract: every section must be present, as a real markdown heading line,
// and in order. Throws a descriptive error otherwise, so a malformed body is rejected before the
// PR is opened. Matches against actual `## …` heading lines (not arbitrary substrings) so a
// section name mentioned in prose can't satisfy the check. Exported for unit testing.
export function assertPrBodySections(
  body: string,
  sections: readonly string[] = PR_BODY_SECTIONS,
): void {
  const headingLines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('## '));
  let cursor = -1;
  for (const heading of sections) {
    const idx = headingLines.indexOf(heading, cursor + 1);
    if (idx === -1) {
      throw new Error(
        `PR body must contain heading lines ${sections.join(', ')} in order; ` +
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

// Corrective re-generations after the first composePr attempt. ≤2 → up to 3 total generations, the
// same bound as the subagents' in-conversation schema retry (#101). Exported for unit testing.
export const COMPOSE_PR_MAX_RETRIES = 2;

// One composePr attempt folded into a single outcome: the valid composition, or the reason it failed
// plus the corrective user message to resend. Two validation layers collapse here — PrCompositionSchema
// (via submittedOutput) and the section contract (assertPrBodySections) — so composePr's retry loop
// stays a flat drive over a message array. Exported for unit testing.
export type ComposeAttempt =
  | { ok: true; value: PrComposition }
  | { ok: false; reason: string; correction: string };

export function compositionOutcome(
  submitted: SubmittedOutput<PrComposition>,
  sections: readonly string[],
): ComposeAttempt {
  if (!submitted.ok) {
    const reason =
      submitted.reason === 'invalid'
        ? `orchestrator PR composition failed schema validation: ${formatSubmitIssues(submitted.issues)}`
        : 'orchestrator did not submit a PR composition';
    return { ok: false, reason, correction: correctiveMessage(submitted) };
  }
  try {
    assertPrBodySections(submitted.value.body, sections);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason,
      correction: `${reason}\nCall \`submit\` again with a corrected body that includes every required section heading, verbatim and in order.`,
    };
  }
  return { ok: true, value: submitted.value };
}

// Truncate to `max` chars on a word boundary: hard-slice, then retreat to the last space so a word
// is never cut mid-token. A single word longer than `max` has no space to retreat to and is
// hard-sliced. Result is always ≤ max. Exported for unit testing.
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const hard = text.slice(0, max);
  const lastSpace = hard.lastIndexOf(' ');
  return (lastSpace > 0 ? hard.slice(0, lastSpace) : hard).trimEnd();
}

// Collapse interior newlines so an interpolated (model-authored) field can neither span multiple
// body lines nor smuggle a `## …` line that assertPrBodySections would read as a section heading.
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

// Deterministic per-section body content for the fallback. Keyed off the heading's leading word so
// the default Summary/Changes/Testing set gets tailored prose; any other configured heading gets a
// generic non-empty line. Never emits a line starting with `## `, so it can't inject a heading.
function fallbackSectionContent(heading: string, group: PrGroup, delivery: WorkerDelivery): string {
  const name = heading.replace(/^#+\s*/, '').toLowerCase();
  if (name.startsWith('change')) {
    return fallbackChangeList(delivery.changes);
  }
  if (name.startsWith('test')) {
    return 'Automated verification output was not captured for this fallback; confirm via CI on this pull request.';
  }
  // The fallback runs when the model never produced a usable composition, so nothing here can be
  // attributed to a tool result — say exactly that rather than implying anything was demonstrated.
  if (name.startsWith('evidence')) {
    return fallbackEvidence(group);
  }
  if (name.startsWith('summar')) {
    return `Auto-generated composition for PR group ${oneLine(group.id)} — ${oneLine(group.title.trim() || group.id)}.`;
  }
  return `Auto-generated fallback content for PR group ${oneLine(group.id)}.`;
}

// The deterministic fallback's Evidence section: no run happened at this layer, so the only honest
// content is the group's acceptance check (when the plan carried one) plus an explicit statement
// that nothing here demonstrates it. Never claims a command ran.
function fallbackEvidence(group: PrGroup): string {
  const check = group.acceptance?.trim();
  const lines = ['- No verification output was captured for this pull request.'];
  if (check) {
    lines.push(
      `- Acceptance check for this group: ${oneLine(check)} — NOT demonstrated here; verify it before merging.`,
    );
  } else {
    lines.push('- This PR group carries no recorded acceptance check.');
  }
  return lines.join('\n');
}

// The deterministic fallback's Changes section. The per-file `summary` fields are raw editor output
// — often narration or self-talk ("owned by another leaf", "already contains the described changes")
// that reads as noise to a human reviewer. The only reliable signal in the fallback is the path +
// change-kind, so group by directory and list paths under each. Always clean, never leaks agent
// chatter, and scannable for multi-file PRs. Paths carry no newlines/`##`, so no section-heading
// injection is possible (the guard the old per-summary formatter needed).
function fallbackChangeList(changes: WorkerDelivery['changes']): string {
  if (changes.length === 0) return '- No file changes were recorded.';
  const groups = new Map<string, Map<string, string[]>>();
  for (const c of changes) {
    const slash = c.path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : c.path.slice(0, slash);
    const file = slash === -1 ? c.path : c.path.slice(slash + 1);
    const byKind = groups.get(dir) ?? new Map<string, string[]>();
    const names = byKind.get(c.kind) ?? [];
    names.push(oneLine(file));
    byKind.set(c.kind, names);
    groups.set(dir, byKind);
  }
  const lines: string[] = [];
  for (const [dir, byKind] of groups) {
    const label = dir === '.' ? '(root)' : `${dir}/`;
    const parts = [...byKind.entries()].map(([kind, names]) => `${kind} ${names.join(', ')}`);
    lines.push(`- **${label}** — ${parts.join('; ')}`);
  }
  return lines.join('\n');
}

// Deterministic PR composition used when the model's composePr attempts are exhausted (invalid
// schema, a missing section, or no submission at all). Built purely from in-memory group + delivery
// data, so it is total (never throws) and does no I/O. The body emits every configured section
// heading verbatim and in order with non-heading content beneath each, so assertPrBodySections
// passes by construction for any section set. Exported for unit testing.
export function buildFallbackComposition(
  group: PrGroup,
  delivery: WorkerDelivery,
  sections: readonly string[],
): PrComposition {
  const subject = group.title.trim() || group.id;
  const title = truncateAtWord(`feat: ${oneLine(subject)}`, 72);
  const body = sections
    .map((heading) => `${heading}\n${fallbackSectionContent(heading, group, delivery)}`)
    .join('\n\n');
  return { title, body };
}

// Standard PR body every aitm-opened PR follows, so reviewers get a consistent shape. The
// Orchestrator model fills these sections from the worker delivery; exported so the format is
// unit-testable and documented in one place.
export const PR_BODY_GUIDE = [
  'body: GitHub-flavored markdown with exactly these four sections, in order, each with its',
  'heading verbatim:',
  `  ${PR_BODY_SECTIONS[0]}`,
  '    1-2 sentences on what changed and why.',
  `  ${PR_BODY_SECTIONS[1]}`,
  '    Scannable bulleted list of WHAT changed. Each entry a terse imperative one-liner naming the',
  '    change (e.g. `add fail-fast env loader with zod validation`), grouped by area when there are',
  '    several files. Treat the raw file notes as LEADS, not prose to copy — rewrite them for a human.',
  `  ${PR_BODY_SECTIONS[2]}`,
  '    How the change was verified (tests, lint). If not verified, say so explicitly.',
  `  ${PR_BODY_SECTIONS[3]}`,
  '    What was actually run and what it showed: the verify command and its outcome, the acceptance',
  '    check for this group and whether it was demonstrated, and anything that was checked and then',
  '    thrown away (an approach tried and reverted, a lead that went nowhere). Report ONLY what the',
  '    material below states was run — no command output here means `Nothing was run to verify this',
  '    change.`, and an acceptance check nothing demonstrates is reported as not demonstrated. A',
  '    plan, an intention, or "should work" is never evidence.',
].join('\n');

// Model guidance for the configured section set. The default set keeps its bespoke per-section
// descriptions (PR_BODY_GUIDE); a custom set gets a generic heading-by-heading instruction.
export function prBodyGuideFor(sections: readonly string[]): string {
  if (sameSections(sections, PR_BODY_SECTIONS)) return PR_BODY_GUIDE;
  return [
    `body: GitHub-flavored markdown with exactly these ${sections.length} sections, in order,`,
    'each as a verbatim heading line followed by the relevant content:',
    ...sections.map((s) => `  ${s}`),
  ].join('\n');
}

function sameSections(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// Fallback LLM step cap when caller passes null / 0 / negative `maxSteps`.
export const DEFAULT_MAX_STEPS = 50;

// Resolve the agent step cap from caller-provided `maxSteps`. Falls back to the
// default when the value is null, zero, or negative. Exported for unit testing.
export function resolveMaxSteps(maxSteps: number | null): number {
  return typeof maxSteps === 'number' && maxSteps > 0 ? maxSteps : DEFAULT_MAX_STEPS;
}

export class Orchestrator {
  constructor(private readonly init: OrchestratorInit) {}

  // Distilled digest when available, else the raw agent-config contents.
  private styleContents(): string {
    return this.init.styleDigest ?? this.init.agentConfig.contents;
  }

  // Effective PR body sections for this run (configured or default).
  private prBodySections(): readonly string[] {
    return resolvePrBodySections(this.init.prBodySections);
  }

  build(context: OrchestratorBuildContext): ToolLoopAgent<never, OrchestratorTools> {
    const commonDeps = {
      credentials: this.init.credentials,
      styleContents: this.styleContents(),
      rollingContext: this.init.rollingContext,
      checkoutPath: context.checkoutPath,
    };
    const tools: OrchestratorTools = {
      planner: makePlannerTool({ ...commonDeps, plannerTools: context.plannerTools }),
      worker: makeWorkerTool({
        ...commonDeps,
        workerTools: context.workerTools,
        baseBranch: context.baseBranch,
        group: context.group,
      }),
      reviewer: makeReviewerTool({
        ...commonDeps,
        reviewerTools: context.reviewerTools,
        pr: context.pr,
        threads: context.threads,
      }),
      done: tool<Record<string, never>, Record<string, never>>({
        description:
          'Signal that all PR groups have been processed and the orchestration is complete.',
        inputSchema: z.object({}),
        execute: async () => ({}),
      }),
    };
    return new ToolLoopAgent<never, OrchestratorTools>({
      model: this.init.credentials.modelFor('orchestrator'),
      instructions: this.buildSystemPrompt(),
      tools,
      stopWhen: [stepCountIs(resolveMaxSteps(this.init.maxSteps)), hasToolCall('done')],
    });
  }

  buildSystemPrompt(): string {
    return render('orchestrator-system', {
      style: this.styleContents(),
      roleGuidance: ORCHESTRATOR_ROLE_PREFIX,
      rollingContext: this.init.rollingContext,
    });
  }

  // Re-write the Worker's draft commit message via the orchestrator model, then
  // `git commit --amend` on the active checkout. Returns the new HEAD SHA.
  //
  // `taskId`, when given, is stamped onto the message as a trailer (see task-commit-marker.ts) so
  // CheckoutHome.hasTaskCommit can detect this exact commit on a resume — the crash window between
  // this amend and WorkLoop persisting the task as done, which would otherwise re-run the Worker and
  // double the commit. Optional so a caller finalizing a whole-group delivery with no single task in
  // scope (or an existing test stub) still compiles and behaves byte-identically (no trailer).
  async finalizeCommit(
    group: PrGroup,
    delivery: WorkerDelivery,
    checkoutPath: string,
    taskId?: string,
  ): Promise<string> {
    const refined = await this.refineCommitMessage(group, delivery);
    const message = taskId === undefined ? refined : `${refined}\n\n${taskCommitTrailer(taskId)}`;
    const runCmd = this.init.runCmd ?? defaultRunCmd;
    const amend = await runCmd('git', ['commit', '--amend', '-m', message], { cwd: checkoutPath });
    if (amend.exitCode !== 0) {
      throw new Error(`git commit --amend failed: ${amend.stderr.trim() || amend.stdout.trim()}`);
    }
    const sha = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath });
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
    const result = await callWithStepTimeout(
      () =>
        generateText({
          model: this.init.credentials.modelFor('orchestrator'),
          system: this.buildSystemPrompt(),
          prompt: this.buildCommitPrompt(group, delivery),
          ...(this.init.timeout !== undefined ? { timeout: this.init.timeout } : {}),
        }),
      this.init.timeout,
    );
    reportUsage(this.init.onUsage, result);
    return result.text.trim();
  }

  // Task-specific ask only — the shared system prompt (style/role/rolling-context) is sent once via
  // the `system` field (see refineCommitMessage), not re-concatenated here per call.
  private buildCommitPrompt(group: PrGroup, delivery: WorkerDelivery): string {
    return [
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
    // Structured output via a submit tool (tool-calling) rather than response_format json_schema,
    // which some OpenAI-compatible providers ignore. `toolChoice: 'auto'` — NOT a forced choice —
    // because thinking-enabled models reject a forced tool_choice outright: Kimi answers
    // "tool_choice 'specified'/'required' is incompatible with thinking enabled" and the group blocks
    // at pr-open. With `submit` the only tool and an explicit "call submit" instruction, every model
    // tested still emits exactly one submit call under 'auto' — the same pattern the Worker/Planner
    // subagents already rely on.
    //
    // Single-shot generateText, not an agent loop (the thinking-model constraint rules out a forced
    // submit), so schema/section recovery is driven inline here: on a botched submit —
    // PrCompositionSchema or assertPrBodySections — append the model's own bad turn plus one
    // corrective user message and re-generate over the growing message array, up to
    // COMPOSE_PR_MAX_RETRIES. Mirrors the subagents' in-conversation #101 retry. Exhausting the
    // retries (or a model that never submits) falls back to a deterministic composition rather than
    // throwing, so composePr is total over composition-quality failures and a whole PR group never
    // blocks at pr-open on prose alone. A genuine transport error (StepTimeoutError from
    // callWithStepTimeout, network) still propagates — the fallback is for bad compositions, not
    // stalled requests.
    const model = this.init.credentials.modelFor('orchestrator');
    const sections = this.prBodySections();
    let messages: ModelMessage[] = [{ role: 'user', content: this.buildPrPrompt(group, delivery) }];
    let lastReason = 'orchestrator did not submit a PR composition';
    for (let attempt = 0; attempt <= COMPOSE_PR_MAX_RETRIES; attempt++) {
      const result = await callWithStepTimeout(
        () =>
          generateText({
            model,
            system: this.buildSystemPrompt(),
            messages,
            tools: {
              submit: tool({
                description:
                  'Submit the composed pull-request title and body (the PrComposition schema).',
                inputSchema: PrCompositionSchema,
                execute: async (composition) => composition,
              }),
            },
            toolChoice: 'auto',
            ...(this.init.timeout !== undefined ? { timeout: this.init.timeout } : {}),
          }),
        this.init.timeout,
      );
      reportUsage(this.init.onUsage, result);
      const outcome = compositionOutcome(submittedOutput(result, PrCompositionSchema), sections);
      if (outcome.ok) return outcome.value;
      lastReason = outcome.reason;
      if (attempt === COMPOSE_PR_MAX_RETRIES) break;
      messages = [
        ...messages,
        ...result.response.messages,
        { role: 'user', content: outcome.correction },
      ];
    }
    const fallback = buildFallbackComposition(group, delivery, sections);
    this.init.onProgress?.(
      `PR composition fell back to generated title/body: ${fallback.title} (${lastReason})`,
    );
    return fallback;
  }

  // Task-specific ask only — the shared system prompt is sent once via `system` (see composePr).
  private buildPrPrompt(group: PrGroup, delivery: WorkerDelivery): string {
    return [
      'Compose the pull-request title and body for this PR group, then call the submit tool with it.',
      '- title: conventional-commit style, ≤72 chars, summarizing the PR group goal below.',
      '  Do NOT copy a single commit message — the title describes the whole group, not one task.',
      prBodyGuideFor(this.prBodySections()),
      '- The `Files changed:` notes below are RAW editor output. They often contain narration,',
      '  repetition, or agent self-talk (e.g. "owned by another leaf", "already contains the described',
      '  changes", "type errors are pre-existing"). NEVER copy such phrases into the body. Rewrite each',
      '  into a clean, human one-liner describing WHAT changed — and group cohesive files so the list',
      '  stays scannable, not one noisy bullet per file.',
      '',
      `PR group goal (use this as the title's subject): ${group.id} — ${group.title}`,
      // The plan's acceptance check — what this group was supposed to prove. It belongs in the body
      // so a human reviewer sees what "done" meant; whether it HOLDS is only what the material below
      // shows, which is why the Evidence guidance forbids reporting it as demonstrated on faith.
      ...(group.acceptance?.trim()
        ? [`Acceptance check the plan set for this group: ${oneLine(group.acceptance)}`]
        : []),
      `Worker draft message (context for the body only — not the title): ${delivery.draftCommitMessage}`,
      'Files changed:',
      ...delivery.changes.map((c) => `  - ${c.kind} ${c.path}: ${c.summary}`),
    ].join('\n');
  }
}

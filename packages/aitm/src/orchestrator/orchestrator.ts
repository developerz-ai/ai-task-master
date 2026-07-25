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

import { callWithStepTimeout } from '@developerz.ai/ai-claude-compat';
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type TimeoutConfiguration,
  tool,
} from 'ai';
import { ExecaError, execa } from 'execa';
import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import type { Role } from '../domain/role.ts';
import type { WorkerDelivery } from '../domain/worker-delivery.ts';
import type { CreatePrInput } from '../github/github-client.ts';
import type { PullRequest } from '../github/schema.ts';
import { type OnUsage, reportUsage } from '../subagents/factory.ts';
import { render } from '../subagents/prompts/templates.ts';
import { MANIFEST_FIELD_MAX } from '../subagents/worker.ts';
import { taskCommitTrailer } from '../workspace/task-commit-marker.ts';
import {
  buildFallbackComposition,
  COMPOSE_PR_MAX_RETRIES,
  compositionOutcome,
  oneLine,
  type PrComposition,
  PrCompositionSchema,
  prBodyGuideFor,
  repairPrBody,
  resolveCommitMessage,
  resolvePrBodySections,
  submitToolInput,
  submittedComposition,
  truncateAtWord,
} from './pr-body.ts';

// Minimal model-resolver surface. The concrete `Credentials` class is structurally compatible;
// tests substitute a `{ modelFor }` literal so they don't need to construct the real provider.
export type ModelProvider = { modelFor(role: Role): LanguageModel };

// Narrow surface — orchestrator only opens PRs, never shells `gh` itself.
// Structural so tests can drop in a literal stub without subclassing GitHubClient.
export type GhClient = {
  createPr(input: CreatePrInput): Promise<PullRequest>;
};

// `git commit --amend` injection seam — defaults to execa so tests can record argv
// without spawning git. Mirrors the GitHubClient.RunCmd shape on purpose.
export type RunCmdOptions = {
  cwd?: string;
  // Per-invocation deadline in ms. Defaults to DEFAULT_CMD_TIMEOUT_MS.
  timeout?: number;
  // Run abort handle. Aborting kills the in-flight child (execa `cancelSignal` → SIGTERM, then
  // SIGKILL) instead of leaving it for the force-exit path to orphan.
  signal?: AbortSignal;
};
export type RunCmdResult = { stdout: string; stderr: string; exitCode: number };
export type RunCmd = (
  file: string,
  args: readonly string[],
  options?: RunCmdOptions,
) => Promise<RunCmdResult>;

// Only local plumbing runs through here (`git commit --amend`, `git rev-parse`), so a minute is
// already an eternity — but a wedged index lock would otherwise stall the group forever.
export const DEFAULT_CMD_TIMEOUT_MS = 60_000;

// Exported for the unit test: the option mapping is the whole point of the chokepoint, and
// asserting it beats spawning git per case.
export function execaOptions(options?: RunCmdOptions): {
  cwd?: string;
  timeout: number;
  cancelSignal?: AbortSignal;
} {
  return {
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    timeout: options?.timeout ?? DEFAULT_CMD_TIMEOUT_MS,
    ...(options?.signal ? { cancelSignal: options.signal } : {}),
  };
}

export const defaultRunCmd: RunCmd = async (file, args, options) => {
  try {
    const r = await execa(file, [...args], execaOptions(options));
    return {
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      exitCode: r.exitCode ?? 0,
    };
  } catch (err) {
    if (err instanceof ExecaError) {
      return {
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: failureStderr(err),
        exitCode: err.exitCode ?? 1,
      };
    }
    throw err;
  }
};

// A child killed by the deadline or by an abort usually wrote nothing to stderr, and finalizeCommit
// reports failures as `git … failed: <stderr>` — so without this an operator reads an empty reason.
function failureStderr(err: ExecaError): string {
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  if (stderr.length > 0) return stderr;
  return err.timedOut || err.isCanceled ? (err.shortMessage ?? err.message) : '';
}

// The orchestrator's role guidance for its two model calls — refining the final commit message and
// composing the PR title + body. buildSystemPrompt weaves it with the style digest and rolling context
// through render('orchestrator-system', …), the one prompt-assembly seam, no call-site concat. Kept
// accurate to the tool surface: the production Orchestrator authors prose, it does not route subagents.
export const COMPOSER_ROLE_PREFIX = [
  '',
  '## Role: PR composer',
  '',
  'You author the per-PR prose for one PR group: the final commit message and the pull-request title',
  '+ body. You see the whole plan and the rolling context of prior PRs, so the prose you write reads',
  'coherently across the run.',
  '',
  'Rules:',
  '  - Specific and terse. No marketing prose. Conventional commit subjects, ≤72 chars.',
  '  - Describe what actually changed; never restate the diff line by line.',
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
  // Run-scoped cancellation for the Orchestrator's OWN work — the two direct generateText calls and
  // the `git commit --amend` plumbing. Orthogonal to `timeout`, which is a per-step deadline. Unset →
  // this work is not cancellable.
  signal?: AbortSignal;
  // Harness-level notice sink for the direct generateText sites — currently only composePr's
  // deterministic fallback (`PR composition fell back …`). Injected so the Orchestrator stays free of
  // the observability rendering details; the adapter wires it to harnessProgress. Mirrors `onUsage`.
  onProgress?: (message: string) => void;
};

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

  buildSystemPrompt(): string {
    return render('orchestrator-system', {
      style: this.styleContents(),
      roleGuidance: COMPOSER_ROLE_PREFIX,
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
    // The run's abort handle, so a SIGINT during the amend kills git instead of orphaning it.
    const cmdOptions: RunCmdOptions = {
      cwd: checkoutPath,
      ...(this.init.signal ? { signal: this.init.signal } : {}),
    };
    const amend = await runCmd('git', ['commit', '--amend', '-m', message], cmdOptions);
    if (amend.exitCode !== 0) {
      throw new Error(`git commit --amend failed: ${amend.stderr.trim() || amend.stdout.trim()}`);
    }
    const sha = await runCmd('git', ['rev-parse', 'HEAD'], cmdOptions);
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
    const started = Date.now();
    const result = await callWithStepTimeout(
      () =>
        generateText({
          model: this.init.credentials.modelFor('orchestrator'),
          system: this.buildSystemPrompt(),
          prompt: this.buildCommitPrompt(group, delivery),
          ...(this.init.timeout !== undefined ? { timeout: this.init.timeout } : {}),
          ...(this.init.signal ? { abortSignal: this.init.signal } : {}),
        }),
      this.init.timeout,
    );
    reportUsage(this.init.onUsage, result, { latencyMs: Date.now() - started });
    return resolveCommitMessage(result.text, group, delivery);
  }

  // Task-specific ask only — the shared system prompt (style/role/rolling-context) is sent once via
  // the `system` field (see refineCommitMessage), not re-concatenated here per call.
  private buildCommitPrompt(group: PrGroup, delivery: WorkerDelivery): string {
    // Cap every interpolated Planner/Worker/editor field at MANIFEST_FIELD_MAX: title, draft message,
    // and per-file summary are model- or plan-authored, not fixed harness strings, so a runaway plan
    // or a hostile task description could otherwise blow up (or inject into) this prompt.
    return [
      'Rewrite the worker draft into a final commit message.',
      'Subject ≤72 chars, conventional-commit style. Body optional, one paragraph.',
      'Output ONLY the message — no labels, no quotes.',
      '',
      `PR group: ${group.id} — ${truncateAtWord(group.title, MANIFEST_FIELD_MAX)}`,
      `Worker draft: ${truncateAtWord(delivery.draftCommitMessage, MANIFEST_FIELD_MAX)}`,
      'Files changed:',
      ...delivery.changes.map(
        (c) => `  - ${c.kind} ${c.path}: ${truncateAtWord(c.summary, MANIFEST_FIELD_MAX)}`,
      ),
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
    //
    // Reading the submission goes through submittedComposition, not submittedOutput directly, so a
    // composition delivered as a JSON *string* is recovered rather than burned on a retry and thrown
    // away — the observed 100% pr-open fallback rate on glm-5.2.
    const model = this.init.credentials.modelFor('orchestrator');
    const sections = this.prBodySections();
    let messages: ModelMessage[] = [{ role: 'user', content: this.buildPrPrompt(group, delivery) }];
    let lastReason = 'orchestrator did not submit a PR composition';
    let lastSubmitted: PrComposition | undefined;
    for (let attempt = 0; attempt <= COMPOSE_PR_MAX_RETRIES; attempt++) {
      const started = Date.now();
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
            ...(this.init.signal ? { abortSignal: this.init.signal } : {}),
          }),
        this.init.timeout,
      );
      reportUsage(this.init.onUsage, result, {
        latencyMs: Date.now() - started,
        retries: attempt > 0 ? 1 : 0,
      });
      const outcome = compositionOutcome(
        submittedComposition(result),
        sections,
        submitToolInput(result),
      );
      if (outcome.ok) return outcome.value;
      lastReason = outcome.reason;
      if (outcome.submitted !== undefined) lastSubmitted = outcome.submitted;
      if (attempt === COMPOSE_PR_MAX_RETRIES) break;
      messages = [
        ...messages,
        ...result.response.messages,
        { role: 'user', content: outcome.correction },
      ];
    }
    // Retries are exhausted, but a body that merely broke the section contract is still the model's
    // real description of this diff — repair it rather than discard it. Only a run where the model
    // never produced a schema-valid composition falls all the way through to the generated stub.
    if (lastSubmitted !== undefined) {
      const repaired = {
        title: lastSubmitted.title,
        body: repairPrBody(lastSubmitted.body, sections, group, delivery),
      };
      this.init.onProgress?.(
        `PR composition repaired: kept the model's title and body, filled the missing sections (${lastReason})`,
      );
      return repaired;
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
      // Every interpolated field below is Planner/Worker/editor output, not a fixed harness string, so
      // each is capped at MANIFEST_FIELD_MAX — a runaway plan or hostile task text can't blow up this
      // prompt. `acceptance` is one-lined first so it can't smuggle a `## …` heading into the body.
      `PR group goal (use this as the title's subject): ${group.id} — ${truncateAtWord(group.title, MANIFEST_FIELD_MAX)}`,
      // The plan's acceptance check — what this group was supposed to prove. It belongs in the body
      // so a human reviewer sees what "done" meant; whether it HOLDS is only what the material below
      // shows, which is why the Evidence guidance forbids reporting it as demonstrated on faith.
      ...(group.acceptance?.trim()
        ? [
            `Acceptance check the plan set for this group: ${truncateAtWord(oneLine(group.acceptance), MANIFEST_FIELD_MAX)}`,
          ]
        : []),
      `Worker draft message (context for the body only — not the title): ${truncateAtWord(delivery.draftCommitMessage, MANIFEST_FIELD_MAX)}`,
      'Files changed:',
      ...delivery.changes.map(
        (c) => `  - ${c.kind} ${c.path}: ${truncateAtWord(c.summary, MANIFEST_FIELD_MAX)}`,
      ),
    ].join('\n');
  }
}

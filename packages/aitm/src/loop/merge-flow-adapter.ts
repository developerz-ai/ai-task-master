// Production wiring for `aitm merge-pr`. Composes the take-over flow's structural ports out of
// the real GitHubClient, checkout-scoped tool surface, conflict resolver, and step-progress
// labels.
//
// Symmetric counterpart to the start flow: `runMergePr` injects this as its `runMergeFlow` seam
// (see src/cli/commands.ts `defaultRunMergeFlow`). Keeping the wiring here — rather than inline
// in the dispatch module — keeps commands.ts to arg-parsing + exit codes (CLAUDE.md SRP scope).

import { resolve as resolvePath } from 'node:path';
import { backgroundProcessTools } from '@developerz.ai/ai-claude-compat';
// Type-only import — no runtime cycle with commands.ts, which imports this module's value.
import type { RunMergeFlowInput } from '../cli/commands.ts';
import { agentStepProgress, shortModelName } from '../observability/step-progress.ts';
import { roleUsageSink } from '../observability/usage-tracker.ts';
import { PrContextStore } from '../state/pr-context-store.ts';
import { isFetchHtmlAvailable } from '../tools/fetch-html.ts';
import { githubThreadTool } from '../tools/github-thread-tool.ts';
import { buildConflictResolver } from './conflict-resolution.ts';
import { applyHooks, makeBudgetCheck, resolveWorkerTools } from './run-loop-adapter.ts';
import { runTakeOverFlow } from './take-over-flow.ts';
import type { WorkLoopResult } from './work-loop.ts';

export type MergeFlowSeams = {
  // Injection seam so a unit test can capture the built TakeOverFlowInput (chiefly the subagents
  // wiring) without driving the real take-over loop. Omitted in production → the real flow.
  runTakeOver?: typeof runTakeOverFlow;
};

export async function mergeFlowAdapter(
  input: RunMergeFlowInput,
  seams: MergeFlowSeams = {},
): Promise<WorkLoopResult> {
  const runTakeOver = seams.runTakeOver ?? runTakeOverFlow;
  const checkoutPath = input.cwd;
  const baseBranch = await input.github.defaultBranch();
  const styleContents = input.styleDigest ?? input.agentConfig.contents;
  // Downloads full failed-CI logs + review comments under .ai-task-master/debugging/pr/<pr>/ so
  // the CI-fix Worker reads them off disk instead of guessing (issue #48).
  const prContext = new PrContextStore(resolvePath(input.cwd, '.ai-task-master'));

  // Build the Claude-Code-style tool surface scoped to the cwd checkout, at parity with `aitm start`
  // (run-loop-adapter.ts): bash deny/allow governance (issue #113), the run's ProcessManager so
  // `bash({ run_in_background: true })` actually backgrounds instead of degrading to the foreground
  // (issue #103), fetchHtml when the curl-impersonate binary is present (issue #112), and operator
  // PreToolUse/PostToolUse hooks (issue #121) — all of which the bare `localEditTools(checkoutPath)`
  // dropped. merge-pr wires no MCP servers, so the resolver's tool set is empty. The Worker gets the
  // full read/write/edit/search/bash set; the Reviewer adds the `github` thread tool.
  const fetchHtmlAvailable = await isFetchHtmlAvailable();
  const background = backgroundProcessTools({ cwd: checkoutPath });
  const baseWorkerTools = resolveWorkerTools(
    {},
    checkoutPath,
    input.resolved.bashRules,
    fetchHtmlAvailable,
    undefined,
    undefined,
    background,
  );
  const workerTools = applyHooks(baseWorkerTools, input, checkoutPath);
  const github = githubThreadTool({ github: input.github });
  const reviewerTools = applyHooks({ ...baseWorkerTools, github }, input, checkoutPath);

  // Role-scoped usage sinks off the run's tracker (issue #114/#190) — undefined when no tracker, so
  // each seam is omitted. The shared CI-fix Worker + the conflict resolver run on the coding tier
  // (their fallback id is the coding id); the Reviewer runs on the reviewer model.
  const workerUsage = roleUsageSink(
    input.usage,
    'worker',
    input.credentials.modelIdForCapability('coding'),
  );
  const reviewerUsage = roleUsageSink(
    input.usage,
    'reviewer',
    input.credentials.modelIdFor('reviewer'),
  );

  // Run-level cost/token ceiling (issue #190), shared with `aitm start`'s WorkLoop budget seam.
  // undefined when no ceiling is configured or there is no tracker, so the flow runs unbounded.
  const budget = makeBudgetCheck(
    input.usage,
    input.resolved.maxCostUsd,
    input.resolved.maxTotalTokens,
  );

  try {
    const result = await runTakeOver({
      pr: input.pr,
      checkoutPath,
      baseBranch,
      github: input.github,
      prContext,
      mergeMethod: input.runState.options.mergeMethod,
      adminMerge: input.resolved.adminMerge ?? false,
      allowForcePush: input.resolved.allowForcePush,
      ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(budget ? { budget } : {}),
      // Pushes go through take-over-flow's shared rebaseAndForcePush helper (rebase onto
      // origin/<base> → `git push --force-with-lease`); `runCmd` defaults to real git via execa.
      subagents: {
        reviewerModel: input.credentials.modelFor('reviewer'),
        reviewerTools,
        // The shared CI-fix session selects the coding tier itself (modelForCapability('coding')).
        credentials: input.credentials,
        workerTools,
        styleContents,
        timeout: { stepMs: input.resolved.llmStepTimeoutMs },
        // Live agent-activity stream (silent-run fix), labeled by the model doing the work.
        onReviewerStepFinish: agentStepProgress(
          `${shortModelName(input.credentials.modelIdFor('reviewer'))} reviewer pr-${input.pr}`,
        ),
        onWorkerStepFinish: agentStepProgress(
          `${shortModelName(input.credentials.modelIdFor('worker'))} ci-fix pr-${input.pr}`,
        ),
        // Each leaf's `editorTag` (file/dir basename, issue #131) names the leaf in its own label.
        onEditorStepFinish: (editorTag) =>
          agentStepProgress(
            `${shortModelName(input.credentials.modelIdFor('worker'))} editor:${editorTag} pr-${input.pr}`,
          ),
        ...(workerUsage ? { onWorkerUsage: workerUsage } : {}),
        ...(reviewerUsage ? { onReviewerUsage: reviewerUsage } : {}),
        ...(input.resolved.formatCommand ? { formatCommand: input.resolved.formatCommand } : {}),
        ...(input.resolved.verifyCommand ? { verifyCommand: input.resolved.verifyCommand } : {}),
        // AI conflict resolution (default-on): resolve a base-moved rebase conflict with the Worker
        // model + tools before blocking the take-over. Gated by config `resolveConflicts`.
        ...(input.resolved.resolveConflicts
          ? {
              resolveConflicts: buildConflictResolver({
                model: input.credentials.modelFor('worker'),
                tools: workerTools,
                styleContents,
                timeout: { stepMs: input.resolved.llmStepTimeoutMs },
                ...(workerUsage ? { onUsage: workerUsage } : {}),
                onStepFinish: agentStepProgress(
                  `${shortModelName(input.credentials.modelIdFor('worker'))} conflict-resolve pr-${input.pr}`,
                ),
              }),
            }
          : {}),
      },
    });

    if (result.kind === 'merged') {
      return {
        kind: 'success',
        outcomes: [{ groupId: `takeover-${result.pr}`, status: 'merged', pr: result.pr }],
      };
    }
    if (result.kind === 'cancelled') {
      return { kind: 'cancelled', outcomes: [] };
    }
    return {
      kind: 'blocked',
      reason: result.reason,
      outcomes: [{ groupId: `takeover-${input.pr}`, status: 'blocked', reason: result.reason }],
    };
  } finally {
    // The adapter owns the ProcessManager it wired: reap any background process a fix Worker left
    // running (killAll is a synchronous no-op when none were started).
    background.manager.killAll();
  }
}

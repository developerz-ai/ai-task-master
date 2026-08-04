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
import type { RunMergeFlowInput } from '../composition/run-input.ts';
import { McpClientManager, mcpInitFrom } from '../mcp/mcp-client.ts';
import { agentStepProgress, shortModelName } from '../observability/step-progress.ts';
import { roleUsageSink } from '../observability/usage-tracker.ts';
import { PrContextStore } from '../state/pr-context-store.ts';
import type { ReviewerTools } from '../subagents/reviewer.ts';
import type { WorkerTools } from '../subagents/worker.ts';
import { isFetchHtmlAvailable } from '../tools/fetch-html.ts';
import { githubThreadTool } from '../tools/github-thread-tool.ts';
import { buildConflictResolver } from './conflict-resolution.ts';
import { Disposer, disposeQuietly } from './disposer.ts';
import { makeBudgetCheck, resolveWorkerTools } from './run-loop-adapter.ts';
import { runTakeOverFlow } from './take-over-flow.ts';
import { deferredPrepareStep, mountRoleTools, resolveReviewerTools } from './tool-resolution.ts';
import type { WorkLoopResult } from './work-loop.ts';

export type MergeFlowSeams = {
  // Injection seam so a unit test can capture the built TakeOverFlowInput (chiefly the subagents
  // wiring) without driving the real take-over loop. Omitted in production → the real flow.
  runTakeOver?: typeof runTakeOverFlow;
  // MCP manager seam, mirroring RunLoopAdapterSeams.makeMcp (issue #339). A test that supplies one
  // is handed it already connected — the adapter never calls connectAll on an injected manager, so
  // no transport is spawned. Omitted → the real manager over `resolved.mcpServers`.
  makeMcp?: (input: RunMergeFlowInput) => McpClientManager;
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
  const github = githubThreadTool({ github: input.github });

  // MCP (issue #339). Until now this flow was handed `{}` and ran on local tools alone, while the
  // main loop's CI-fix session — doing the same job on the same kind of PR — had the operator's
  // servers. Constructed HERE rather than at the CLI boundary because the sibling adapter owns its
  // manager the same way, seam included, and one shape for both flows beats two.
  const mcp =
    seams.makeMcp?.(input) ?? new McpClientManager(mcpInitFrom(input.resolved, input.logger));

  // One release stack for the whole flow, mirroring runLoopAdapter. Registered BEFORE connectAll:
  // connectAll spawns each server's stdio child as it goes, so a run aborted mid-connect can already
  // have live children. This also closes a pre-existing gap — `background` was reaped only by the
  // `finally`, which a second Ctrl-C skips, orphaning whatever a fix Worker left running.
  const disposer = new Disposer();
  disposer.add(() => mcp.close());
  disposer.add(() => background.manager.killAll());
  const reapOnAbort = (): void => {
    void disposeQuietly(disposer);
  };
  input.signal?.addEventListener('abort', reapOnAbort, { once: true });
  // Registered last → released first, so teardown detaches the listener before the reaping it would
  // otherwise re-trigger.
  disposer.add(() => {
    input.signal?.removeEventListener('abort', reapOnAbort);
  });
  if (!seams.makeMcp) await mcp.connectAll();

  const { tools: workerTools, mount: workerMount } = mountRoleTools<WorkerTools>(
    'worker',
    mcp,
    (set) =>
      resolveWorkerTools(
        set,
        checkoutPath,
        input.resolved.bashRules,
        fetchHtmlAvailable,
        undefined,
        undefined,
        background,
      ),
    input,
    checkoutPath,
  );
  const { tools: reviewerTools, mount: reviewerMount } = mountRoleTools<ReviewerTools>(
    'reviewer',
    mcp,
    (set) =>
      resolveReviewerTools(
        set,
        checkoutPath,
        github,
        input.resolved.bashRules,
        fetchHtmlAvailable,
        background,
      ),
    input,
    checkoutPath,
  );

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
      // Threaded through the take-over flow's shared CI-fix session (runCiFixSession forwards it).
      ...(input.logger ? { logger: input.logger } : {}),
      // Pushes go through take-over-flow's shared rebaseAndForcePush helper (rebase onto
      // origin/<base> → `git push --force-with-lease`); `runCmd` defaults to real git via execa.
      subagents: {
        reviewerModel: input.credentials.modelFor('reviewer'),
        reviewerTools,
        // The shared CI-fix session selects the coding tier itself (modelForCapability('coding')).
        credentials: input.credentials,
        workerTools,
        deferredMount: workerMount,
        reviewerDeferredMount: reviewerMount,
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
                // The resolver runs on the Worker's record, deferred surface included (issue #339).
                prepareStep: deferredPrepareStep<WorkerTools>(undefined, workerMount, workerTools),
                timeout: { stepMs: input.resolved.llmStepTimeoutMs },
                ...(workerUsage ? { onUsage: workerUsage } : {}),
                onStepFinish: agentStepProgress(
                  `${shortModelName(input.credentials.modelIdFor('worker'))} conflict-resolve pr-${input.pr}`,
                ),
                ...(input.logger ? { logger: input.logger } : {}),
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
    // Drains everything the flow acquired — the MCP stdio children and any background process a fix
    // Worker left running. Draining twice is safe: an abort-time drain leaves an emptied stack, and
    // a drain started while another is in flight queues behind it.
    await disposeQuietly(disposer);
  }
}

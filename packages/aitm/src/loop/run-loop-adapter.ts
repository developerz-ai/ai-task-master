// Production wiring for `aitm start`. Composes the WorkLoop's structural ports out of the
// real Planner, Orchestrator, InPlaceCheckout, PlanGraph, MCP tools and GitHubClient.
//
// Symmetric counterpart to the merge-pr flow: `runStart` injects this as its `runLoop` seam
// (see src/cli/commands.ts `defaultRunLoop`). Every external dependency is reachable through
// a seam so the four WorkLoopResult branches are unit-testable without spawning subagents,
// git, or `gh` — the integration suite (test/integration/) covers the real stack.
//
// Flow:
//   1. Resume detection — if state already holds prGroups, reuse them; else run the Planner.
//   2. Persist the plan into RunState (status → working).
//   3. Build a *live* PlanGraph that re-reads the mirrored prGroups on every ready()/isComplete()
//      so status transitions written by the loop are visible (PlanGraph snapshots at construction).
//   4. Bridge the Orchestrator/subagents into the WorkLoopOrchestrator port and run the loop.
//
// Planning (branch assignment, the Planner subagent, the pre-planning scout survey) lives in
// planner-wiring.ts; MCP/local tool-set resolution and deferred-tool mounting live in
// tool-resolution.ts; the observability rigging every subagent call builds (RunStep tag, label,
// heartbeat, onStepFinish, retry line, stream renderer) lives in subagent-session.ts
// (buildSubagentSession); small cross-cutting glue (error normalization, style resolution,
// transcript begin/resume, the state port contract, budget check) lives in adapter-support.ts.
// This file keeps the orchestrator bridge: the WorkLoopOrchestrator port implementation that
// drives the Worker/Reviewer/self-review/CI-fix subagents over one PR group at a time.

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  type BackgroundProcessTools,
  backgroundProcessTools,
  type SubagentHandle,
} from '@developerz.ai/ai-claude-compat';
import type { ModelMessage } from 'ai';
import { buildCompactionStep } from '../compaction/compaction-step.ts';
import { Compactor } from '../compaction/compactor.ts';
// Type-only import — no runtime cycle with commands.ts, which imports this module's value.
import type { RunLoopInput } from '../composition/run-input.ts';
import type { WebSearchConfig } from '../config/schema.ts';
import { isOpenRouterEndpoint } from '../domain/model.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { makeStepCounter } from '../observability/run-step.ts';
import {
  agentLabel,
  agentStepProgress,
  harnessProgress,
  type RunStep,
  shortModelName,
} from '../observability/step-progress.ts';
import { roleUsageSink } from '../observability/usage-tracker.ts';
import { OpenRouterClient } from '../openrouter/client.ts';
import { ModelLimitsRegistry } from '../openrouter/model-limits.ts';
import {
  providerOptionsWithServerTools,
  type WebSearchOptions,
  webSearchServerTool,
} from '../openrouter/server-tools.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { withAcceptanceCheck } from '../plan/acceptance.ts';
import { PlanGraph } from '../plan/plan-graph.ts';
import { PrContextStore } from '../state/pr-context-store.ts';
import type { GoalAssessment } from '../subagents/goal-assessor.ts';
import {
  createReviewerAgent,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerTools,
  runReviewer as runReviewerSubagent,
} from '../subagents/reviewer.ts';
import { harnessContextBlock, reminderAgentSystemPrompt } from '../subagents/role-prompt.ts';
import { bootstrapSpecialists } from '../subagents/specialist-bootstrap.ts';
import {
  buildSpecialistSignal,
  composeSpecialistGuidance,
  discoverSpecialists,
  selectSpecialistWithScore,
} from '../subagents/specialist-registry.ts';
import {
  createWorkerAgent,
  runWorker as runWorkerSubagent,
  WORKER_SYSTEM_PREFIX,
  type WorkerTools,
} from '../subagents/worker.ts';
import { isFetchHtmlAvailable } from '../tools/fetch-html.ts';
import { githubThreadTool } from '../tools/github-thread-tool.ts';
import { commitsAheadOfBase, runGit } from '../workspace/git-exec.ts';
import { InPlaceCheckout } from '../workspace/in-place-checkout.ts';
import {
  type AdapterStatePort,
  beginTranscript,
  createRollingContextAccumulator,
  describeError,
  makeBudgetCheck,
  memoryIndexFor,
  memoryToolFor,
  resolveStyleContents,
  resumeMessagesFor,
  runEndOutcome,
  runProgressReminder,
} from './adapter-support.ts';
import { runFixSession } from './ci-fix.ts';
import { buildConflictResolver } from './conflict-resolution.ts';
import { Disposer, disposeQuietly } from './disposer.ts';
import {
  defaultAssessGoal,
  defaultPlanGroups,
  namespaceWaveGroups,
  type PlanGroupsOutcome,
} from './planner-wiring.ts';
import { makeProgressTee } from './progress-file.ts';
import { hasInterruptedGroup, normalizeResumeStatus } from './resume-normalize.ts';
import { investigateReviewThreads } from './review-team-wiring.ts';
import { runSelfReviewSession } from './self-review.ts';
import { buildSubagentSession } from './subagent-session.ts';
import {
  appendIndexBlock,
  applyHooks,
  type BackgroundTools,
  buildExploreFor,
  mountDeferredTools,
  resolveReviewerTools,
  resolveWorkerTools,
  type WithExplore,
  type WithMemory,
  withActiveTools,
} from './tool-resolution.ts';
import {
  type GroupOutcome,
  type ReviewerInvocation,
  WorkLoop,
  type WorkLoopGithub,
  type WorkLoopGraph,
  type WorkLoopOrchestrator,
  type WorkLoopResult,
  type WorkLoopState,
} from './work-loop.ts';

export {
  persistRollingContext,
  RAW_STYLE_MAX_CHARS,
  runStepContextLine,
} from './adapter-support.ts';
export {
  branchFor,
  parseRemoteHeads,
  planToPrGroups,
  remoteBranchNames,
  sanitizeBranchComponent,
} from './planner-wiring.ts';
export { recordStepDeltas, retryProgressMessage } from './subagent-session.ts';
export {
  activeToolNames,
  exploreReadTools,
  localEditTools,
  localReadTools,
  mcpTool,
  resolvePlannerTools,
} from './tool-resolution.ts';
// The reminder-channel prompt helpers (issue #106) now live in role-prompt.ts so the CI-fix worker
// and the take-over reviewer (issue #141) can reuse them without importing back into this adapter
// (import cycle). Re-exported here for the callers and tests that reach them through the adapter.
// Re-exported so existing importers (production and test) reach cross-cutting helpers, planning,
// and tool resolution through this module's surface without every caller having to know which of
// the sibling files (adapter-support.ts, subagent-session.ts, tool-resolution.ts,
// planner-wiring.ts) a given symbol now lives in.
export {
  type AdapterStatePort,
  applyHooks,
  createRollingContextAccumulator,
  describeError,
  harnessContextBlock,
  makeBudgetCheck,
  mountDeferredTools,
  type PlanGroupsOutcome,
  reminderAgentSystemPrompt,
  resolveStyleContents,
  resolveWorkerTools,
  runProgressReminder,
};

export type OrchestratorBridgeCtx = {
  input: RunLoopInput;
  mcp: McpClientManager;
  rollingContext: string;
  // Whether the curl-impersonate binary is present, resolved once per run (isFetchHtmlAvailable is
  // async; the orchestrator builder is sync). Gates the optional fetchHtml tool (issue #112).
  fetchHtmlAvailable: boolean;
  // State port so the bridge can persist the accumulated rolling context after each PR opens (#123).
  state: AdapterStatePort;
  // Resolve the N/M step counter for a group/task so every harness + agent line carries the run's
  // position (`group 2/5`, `task 3/38`). Built once per run in runLoopAdapter over the plan.
  stepCounter: ReturnType<typeof makeStepCounter>;
  // The run's single background-process handle (issue #103). Threaded into the worker/reviewer tool
  // resolvers so `bash({ run_in_background: true })` backgrounds and bashOutput/killBash are mounted.
  background: BackgroundTools;
  // Test seam (issue #189): override the Worker subagent runner so a test can deterministically
  // capture the worker input the bridge builds — chiefly that the resolved `subagentLimit` cap
  // is threaded through. Omitted in production, where it defaults to the real runWorkerSubagent.
  workerRunner?: typeof runWorkerSubagent;
  // Test seam: override specialist discovery so a test can force a discovery failure and assert the
  // roster degrades to empty instead of poisoning the memoized promise for every later Worker.
  // Omitted in production, where it defaults to the real discoverSpecialists.
  discoverSpecialists?: typeof discoverSpecialists;
};

export type RunLoopAdapterSeams = {
  planGroups?: (
    input: RunLoopInput,
    mcp: McpClientManager,
    fetchHtmlAvailable: boolean,
  ) => Promise<PlanGroupsOutcome>;
  // Judges the ORIGINAL goal against the repo after a wave lands, deciding whether another wave is
  // planned. Stubbed in unit tests; the default runs the goal assessor subagent.
  assessGoal?: (
    input: RunLoopInput,
    mcp: McpClientManager,
    fetchHtmlAvailable: boolean,
    delivered: readonly string[],
  ) => Promise<GoalAssessment>;
  makeOrchestrator?: (
    ctx: OrchestratorBridgeCtx,
  ) => WorkLoopOrchestrator | Promise<WorkLoopOrchestrator>;
  makeCheckout?: (input: RunLoopInput) => CheckoutHome;
  makeGithub?: (input: RunLoopInput) => WorkLoopGithub;
  makeMcp?: (input: RunLoopInput) => McpClientManager;
  makeBackground?: (input: RunLoopInput) => BackgroundProcessTools;
  state?: AdapterStatePort;
};

// Re-exported for the seam type below without re-importing CheckoutHome everywhere.
export type CheckoutHome = import('./work-loop.ts').CheckoutHome;

export async function runLoopAdapter(
  input: RunLoopInput,
  seams: RunLoopAdapterSeams = {},
): Promise<WorkLoopResult> {
  const state = seams.state ?? input.state;
  // MCP is only needed when a real Planner / Orchestrator default runs. When both are stubbed
  // (unit tests), we never connect, so no transport is spawned.
  const usesMcp = !seams.planGroups || !seams.makeOrchestrator;
  const mcp = seams.makeMcp
    ? seams.makeMcp(input)
    : new McpClientManager({
        servers: input.resolved.mcpServers,
        ...(input.resolved.mcpRoleAllowlist !== undefined
          ? { roleAllowlist: input.resolved.mcpRoleAllowlist }
          : {}),
        ...(input.logger ? { logger: input.logger } : {}),
      });

  // One ProcessManager per run, bound to the repo root the single in-place checkout also uses, so a
  // `bash({ run_in_background: true })` (dev server, log tailer) actually backgrounds instead of
  // degrading to the foreground (issue #103). The adapter OWNS its lifecycle: killAll() reaps every
  // process a worker/reviewer left running.
  const background = seams.makeBackground?.(input) ?? backgroundProcessTools({ cwd: input.cwd });

  // One release stack for the whole run: the `finally` below and the abort reaper both drain THIS
  // disposer, so every run-scoped acquisition has exactly one registered release and neither exit
  // path can forget one. LIFO, so the order below is the reverse of the teardown order.
  const disposer = new Disposer();
  // Registered BEFORE connectAll: connectAll connects every server in parallel and each one spawns its
  // stdio child as it goes, so a run aborted mid-connect (reapOnAbort drains this disposer) can already
  // have live children — even though connectAll no longer rejects on a per-server failure. close()
  // reaps whatever connected and is idempotent, so registering it for a run that never connects costs
  // nothing.
  disposer.add(() => mcp.close());
  disposer.add(() => background.manager.killAll());

  // Reap the MCP stdio children (Experimental_StdioMCPTransport spawns them, mcp-client.ts) AND any
  // leftover background processes the instant the run is aborted. A second Ctrl-C force-exits the
  // process (cli.ts installSignalHandlers) and Node's default signal termination skips the `finally`
  // below, so relying on it alone orphans them — reap eagerly on abort while we still can. Draining
  // twice is safe: the second drain finds an emptied stack, and a drain started while another is in
  // flight queues behind it, so the `finally` awaits the abort-time teardown instead of racing it.
  const reapOnAbort = () => {
    void disposeQuietly(disposer);
  };
  input.signal?.addEventListener('abort', reapOnAbort, { once: true });
  // Registered last → released first, so teardown detaches the listener before the reaping it would
  // otherwise re-trigger. A normally-completing run never leaks it.
  disposer.add(() => {
    input.signal?.removeEventListener('abort', reapOnAbort);
  });

  try {
    if (usesMcp && !seams.makeMcp) {
      await mcp.connectAll();
    }

    const current = await state.read();
    const rollingContext = (await state.readContext?.()) ?? '';

    // Resolve ONCE per run (a subprocess probe): the fetchHtml tool is mounted only when the
    // curl-impersonate binary is present. Threaded into both the Planner (planGroups) and the sync
    // orchestrator builder so the probe never runs twice (issue #112).
    const fetchHtmlAvailable = await isFetchHtmlAvailable();

    // ---- Remaining deps ----------------------------------------------------
    // Agents work in ONE checkout, scheduled as a team. InPlaceCheckout is single-slot, so
    // concurrency is a single slot: sequential groups, no two subagents mutating the tree at once.
    // (A later task reframes concurrency as a cap.)
    // Built ONCE for the whole run — these are wave-invariant, unlike the plan-derived pieces below.
    const effectiveConcurrency = 1;
    const checkout =
      seams.makeCheckout?.(input) ??
      new InPlaceCheckout(input.cwd, { allowDirty: input.resolved.allowDirty ?? false });
    const github = seams.makeGithub?.(input) ?? input.github;
    const budgetCheck = makeBudgetCheck(
      input.usage,
      input.resolved.maxCostUsd,
      input.resolved.maxTotalTokens,
    );
    // PlanGraph captures its groups at construction, so rebuild it per call against the
    // mirror that workLoopState keeps in sync after every persisted update.
    let liveGroups: readonly PrGroup[] = [];
    const graph: WorkLoopGraph = {
      ready: () => PlanGraph.trusted(liveGroups).ready(),
      isComplete: () => PlanGraph.trusted(liveGroups).isComplete(),
    };
    // Mirrored out of every persisted update for the same reason liveGroups is: each wave builds a
    // FRESH WorkLoop, and seeding it from the run-start snapshot would restart the session counter
    // per wave — quietly turning maxSessions from a run bound into a per-wave one.
    let liveSessionCount = current.sessionCount;
    const workLoopState: WorkLoopState = {
      update: async (mutator) => {
        const next = await state.update(mutator);
        liveGroups = next.prGroups;
        liveSessionCount = next.sessionCount;
        return next;
      },
      writePlan: async (groups) => {
        await state.writePlan?.(groups);
      },
    };

    // ---- Wave loop ---------------------------------------------------------
    // A plan is one WAVE, not the whole run. When every group in a wave lands, the goal assessor
    // reads the repo as it now is and either ends the run or names what still remains, which the
    // Planner plans as the next wave against real code rather than a guess. Without this, a plan
    // that under-covers the goal ships a fraction of it and exits 0.
    // Any non-success outcome returns immediately, so blocked / cancelled / session-capped runs
    // behave exactly as they did before waves existed.
    const allOutcomes: GroupOutcome[] = [];
    const assessGoal = seams.assessGoal ?? defaultAssessGoal;
    let waveGoal = input.goal;
    let landed: PrGroup[] = [];
    // Every goal this run has already planned a wave for. A run is bounded by cost ceilings, not by a
    // wave count — but an assessor that keeps naming the SAME remaining work is not making progress,
    // it is livelocked, and another identical wave would burn the operator's budget for nothing.
    const plannedGoals = new Set<string>([input.goal]);
    for (let wave = 1; ; wave++) {
      let groups: PrGroup[];
      let freshPlan = false;
      if (wave === 1 && current.prGroups.length > 0) {
        // Resume: a run interrupted mid-lifecycle persisted its groups as 'in-progress'/'awaiting-pr',
        // which PlanGraph.ready() won't schedule. Normalize them back to 'pending' (preserving stage +
        // pr) so they re-enter the loop and resume at their persisted stage instead of being stranded.
        if (hasInterruptedGroup(current.prGroups)) {
          const next = await state.update((s) => ({
            ...s,
            prGroups: normalizeResumeStatus(s.prGroups),
          }));
          groups = next.prGroups;
        } else {
          groups = current.prGroups;
        }
      } else {
        const planFn = seams.planGroups ?? defaultPlanGroups;
        // Later waves plan the REMAINING goal; wave 1 plans the goal as given.
        const outcome = await planFn({ ...input, goal: waveGoal }, mcp, fetchHtmlAvailable);
        // A later wave that cannot plan ends the run on what already shipped. Reporting `blocked`
        // there would bury several merged PRs under the failure of the follow-up planning call.
        if (outcome.kind === 'blocked') {
          if (wave > 1) return { kind: 'success', outcomes: allOutcomes };
          return { kind: 'blocked', reason: outcome.reason, outcomes: [] };
        }
        if (outcome.kind === 'error') {
          if (wave > 1) return { kind: 'success', outcomes: allOutcomes };
          return { kind: 'blocked', reason: `planner error: ${outcome.error}`, outcomes: [] };
        }
        if (outcome.groups.length === 0) {
          if (wave > 1) return { kind: 'success', outcomes: allOutcomes };
          return { kind: 'blocked', reason: 'planner produced no PR groups', outcomes: [] };
        }
        // Append, never replace: the landed groups stay in state so the graph still sees them as
        // satisfied dependencies and the operator keeps the full history in plan.md.
        groups = [...landed, ...namespaceWaveGroups(outcome.groups, landed, wave)];
        freshPlan = true;
      }

      // Step counter over the plan (claudetm parity): group N/M in group-mode, task N/M in prPerTask.
      // Group order + membership are fixed within a wave, so build it once per wave and share it with
      // the orchestrator bridges (their harness + agent lines) and the WorkLoop (its transition lines).
      const stepCounter = makeStepCounter(groups, current.options.prPerTask ?? false);

      // ---- Live graph + state proxy ------------------------------------------
      // Validate the plan's structure ONCE per wave, at acceptance: duplicate ids, dangling deps, and
      // cycles are functions of group ids + dependsOn edges, which stay fixed for the wave. The
      // per-tick ready()/isComplete() below only read live statuses, so they rebuild via
      // PlanGraph.trusted() and skip re-paying validate()'s DFS every tick (this gate also keeps that
      // memoized DFS terminating).
      try {
        PlanGraph.validate(groups);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (wave > 1) return { kind: 'success', outcomes: allOutcomes };
        return { kind: 'blocked', reason: msg, outcomes: [] };
      }
      // Persist a freshly-planned roster only after it validates. Writing it before validation would
      // leave a structurally-invalid plan in resumable state: every later run would take the resume
      // branch, re-reject the same plan, and never replan.
      if (freshPlan) {
        await state.update((s) => ({ ...s, status: 'working', prGroups: groups }));
      }
      liveGroups = groups;

      const orchestrator = await (seams.makeOrchestrator ?? defaultMakeOrchestrator)({
        input,
        mcp,
        rollingContext,
        fetchHtmlAvailable,
        state,
        stepCounter,
        background,
      });

      const loop = new WorkLoop({
        orchestrator,
        github,
        state: workLoopState,
        home: checkout,
        graph,
        // Persist addressed review threads so the addressing-reviews loop dedups across re-polls.
        prContext: new PrContextStore(resolvePath(input.cwd, '.ai-task-master')),
        concurrency: effectiveConcurrency,
        autoMerge: input.resolved.autoMerge,
        selfReview: input.resolved.selfReview,
        prPerTask: current.options.prPerTask ?? false,
        maxSessions: input.resolved.maxSessions,
        maxCiFixAttempts: input.resolved.maxCiFixAttempts,
        mergeMethod: input.resolved.mergeMethod,
        adminMerge: input.resolved.adminMerge ?? false,
        initialSessionCount: liveSessionCount,
        // Every harness narration line also lands in .ai-task-master/progress.md via the state port.
        progress: makeProgressTee(
          state.appendProgress ? { append: state.appendProgress.bind(state) } : {},
        ),
        stepCounter,
        ...(input.signal ? { signal: input.signal } : {}),
        // Run-level cost/token ceiling (issue #190). Omitted when no ceiling is configured.
        ...(budgetCheck ? { budget: budgetCheck } : {}),
      });
      const result = await loop.run();
      allOutcomes.push(...result.outcomes);
      // Only a clean sweep earns another wave. Anything else (blocked, awaiting-pr, session-cap,
      // cancelled) is the operator's to resolve — planning more work on top would pile onto a run
      // that already needs attention.
      if (result.kind !== 'success') return { ...result, outcomes: allOutcomes };

      landed = [...liveGroups];
      const assessment = await assessGoal(input, mcp, fetchHtmlAvailable, deliveredSummary(landed));
      if (assessment.complete) {
        return { kind: 'success', outcomes: allOutcomes };
      }
      if (plannedGoals.has(assessment.remaining)) {
        harnessProgress(
          `goal still not met, but the remaining work is unchanged from a wave already run — stopping: ${assessment.remaining}`,
          { phase: 'planning' },
        );
        return { kind: 'success', outcomes: allOutcomes };
      }
      plannedGoals.add(assessment.remaining);
      harnessProgress(`goal not yet met — planning another wave: ${assessment.remaining}`, {
        phase: 'planning',
      });
      waveGoal = assessment.remaining;
    }
  } finally {
    await disposeQuietly(disposer);
  }
}

// One line per landed group for the goal assessor's prompt. It checks the REPO, not this list — the
// list only tells it what to expect, so an absent capability reads as a gap rather than as something
// it simply has not found yet.
function deliveredSummary(groups: readonly PrGroup[]): string[] {
  return groups.map((g) => {
    const pr = typeof g.pr === 'number' ? ` (PR #${g.pr}, ${g.status})` : ` (${g.status})`;
    return `${g.id}: ${g.title}${pr}`;
  });
}

// The effective verify command for the pre-PR self-review: the configured verifyCommand when set,
// else a conservative zero-config fallback — a typecheck for a TS repo. Best-effort: a fallback tool
// missing from PATH exits 127, which the self-review pass treats as "no verify ran" (never a bogus
// failure). Configuring `verifyCommand` is the reliable path. Exported for unit testing.
export function selfReviewVerifyCommand(
  configured: string | null | undefined,
  cwd: string,
): string | undefined {
  if (configured) return configured;
  if (existsSync(resolvePath(cwd, 'tsconfig.json'))) return 'tsc --noEmit';
  return undefined;
}

// ---- Orchestrator bridge ---------------------------------------------------

// web_search server-tool gating (issue #112) + optional domain filters (issue #195). The tri-state
// gate lives on a bare boolean or, for the object form, on its `enabled` field: undefined → CI-fix
// sessions only (highest lookup value, bounded cost); true → all Worker calls; false → never. When
// enabled, the object form's allowed/excluded domains ride the server-tool payload. Returns the
// providerOptions fragment (openrouter namespace) or undefined when web_search should not attach.
//
// Attaches ONLY on an OpenRouter endpoint (isOpenRouterEndpoint): the server tool lives in the
// `openrouter` provider namespace, so on any other OpenAI-compatible endpoint (z.ai, kimi, a vLLM
// gateway) it is a tool schema the provider rejects outright (observed: `tools[0].type:type is
// illegal` on z.ai, which blocked a CI-fix session) — attaching it there crashes the request rather
// than degrading. The provider-agnostic DuckDuckGo `webSearch` function tool stays in the tool set on
// every endpoint, so web search still works elsewhere; only this OpenRouter-native server tool is
// gated off. Exported for tests.
export function webSearchProviderOptions(
  webSearch: WebSearchConfig | undefined,
  ciFix: boolean,
  baseURL: string | undefined,
): ReturnType<typeof providerOptionsWithServerTools> | undefined {
  if (!isOpenRouterEndpoint(baseURL)) return undefined;
  const config = typeof webSearch === 'object' ? webSearch : undefined;
  // The tri-state flag is the bare boolean, or the object's `enabled` (unset → CI-fix-only default).
  const flag = typeof webSearch === 'boolean' ? webSearch : config?.enabled;
  const enabled = flag === true || (ciFix && flag !== false);
  if (!enabled) return undefined;
  const options: WebSearchOptions = {
    ...(config?.allowedDomains?.length ? { allowed_domains: config.allowedDomains } : {}),
    ...(config?.excludedDomains?.length ? { excluded_domains: config.excludedDomains } : {}),
  };
  return providerOptionsWithServerTools([webSearchServerTool(options)]);
}

export function defaultMakeOrchestrator(ctx: OrchestratorBridgeCtx): WorkLoopOrchestrator {
  const { input, mcp, rollingContext, fetchHtmlAvailable, state, stepCounter, background } = ctx;
  const workerRunner = ctx.workerRunner ?? runWorkerSubagent;
  const discoverRoster = ctx.discoverSpecialists ?? discoverSpecialists;
  // Rolling context accumulates across groups within a run (issue #123): seeded from what a resumed
  // run already persisted (ctx.rollingContext), grown by openPr after each PR, and read LIVE by the
  // worker + ci-fix bridges — so group N+1 plans against group N's digest. Appends are serialized so
  // the concurrent-batch openPr path (WorkLoop's Promise.all) can't lose a group's digest.
  const rollingCtx = createRollingContextAccumulator(state, rollingContext);
  const style = resolveStyleContents(input);
  // Per-step LLM deadline armed on every generate site in this bridge (issue #129).
  const stepTimeout = { stepMs: input.resolved.llmStepTimeoutMs };

  // Target-repo domain specialists (`.claude/agents/*.md`), discovered once per run and memoized —
  // the roster can't change mid-run, and a repo without the dir just yields []. The Worker path picks
  // the best match per group and layers its guidance onto WORKER_SYSTEM_PREFIX (byte-identical to
  // today when nothing matches). When the repo ships NO agents and generateSpecialists is on
  // (default), a team is generated on the fly from the goal + accepted plan and persisted under
  // `.ai-task-master/agents/` — a resume reuses it without a second LLM call (issue #255). Lazy:
  // the first roster consumer pays for generation, so a run that never routes never generates.
  let specialistsPromise: ReturnType<typeof discoverSpecialists> | undefined;
  const specialistRoster = () =>
    (specialistsPromise ??= (async () => {
      // Never reject: any failure degrades to the empty roster, byte-identical to a repo with no
      // agents. The result is memoized, so a rejection here would be re-thrown into every later
      // Worker that awaits the roster and would surface as an unhandled rejection from the
      // fire-and-forget announce below (fatal on Node ≥15). Discovery I/O, a state port without
      // read() (test stubs), a stub credentials object, or a provider failure during bootstrap all
      // land in the same catch.
      try {
        const shipped = await discoverRoster(input.cwd);
        if (shipped.length > 0) return shipped;
        if (input.resolved.generateSpecialists === false) return shipped;
        const runState = await state.read();
        const bootstrapUsage = roleUsageSink(
          input.usage,
          'planner',
          input.credentials.modelIdFor('planner'),
        );
        return await bootstrapSpecialists(
          {
            model: input.credentials.modelFor('planner'),
            timeout: stepTimeout,
            ...(bootstrapUsage !== undefined ? { onUsage: bootstrapUsage } : {}),
            onProgress: (message) => harnessProgress(message),
          },
          {
            goal: input.goal,
            groups: runState.prGroups,
            ...(input.styleDigest !== undefined ? { styleDigest: input.styleDigest } : {}),
            stateDir: resolvePath(input.cwd, '.ai-task-master'),
          },
        );
      } catch {
        return [];
      }
    })());
  // Announce the discovered roster once, up front (mirrors claudetm's "Found N subagents"). For a
  // repo that ships agents this is a cheap dir read; for a generated team it also fronts the one
  // LLM call so the roster line still appears before the first group starts. Fire-and-forget —
  // specialistRoster() never rejects (failures degrade to [] inside it); the .catch is a final guard
  // so a throw from the announce callback itself can never become an unhandled rejection.
  void specialistRoster()
    .then((roster) => {
      if (roster.length > 0) {
        harnessProgress(
          `found ${roster.length} specialist(s): ${roster.map((a) => a.name).join(', ')}`,
        );
      }
    })
    .catch(() => {});

  // Per-group CI-fix conversation handles, retained in memory for the life of the run so successive
  // fix passes for a group continue the same Worker conversation instead of re-planning cold — the
  // Worker remembers what earlier passes already tried (issue #107). Never shared across groups; not
  // persisted (a crash falls back to a cold start — durable transcripts are #108).
  const ciFixHandles = new Map<string, SubagentHandle<WorkerTools>>();

  // Per-group Coordinator conversation, carried task→task for the life of the group. Timing a real
  // run showed roughly half the wall-clock going to re-orientation: every task in a group cold-started
  // a Coordinator that re-read the same dozen files (`repository.ts`, `errors.ts`, `app.ts`,
  // `package.json` … each 4-6 times across one group), then wrote ~40 lines. Survey cost does not
  // shrink with task size, so paying it per task is the single largest tax on throughput.
  //
  // Only the MESSAGES are carried, never the agent: task N+1 builds a fresh agent (its own routed
  // specialist, its own acceptance block, its own step budget) and inherits the history — the same
  // shape the crash-resume path uses. Not persisted; a crash falls back to the transcript resume.
  const workerHandles = new Map<string, ModelMessage[]>();

  // One Compactor per run: summarize-and-continue when a subagent's context window fills, instead
  // of dying on a provider overflow on the "really big PRs" runs aitm exists for (issue #102). The
  // summarizer is the fast tier; model-limits come from the OpenRouter catalog (lazy, cached; a
  // lookup miss or fetch failure just skips compaction — non-fatal). Threaded into both worker
  // paths (stage machine + CI-fix) and the reviewer.
  // Reuse the run's single ModelLimitsRegistry (built in runStart for the usage tracker) so the
  // catalog is fetched at most once (issue #114); fall back to a fresh one for callers that don't
  // provide it (tests, direct adapter use).
  const limits =
    input.modelLimits ??
    new ModelLimitsRegistry(
      new OpenRouterClient(input.resolved.openrouterApiKey, input.resolved.baseURL, input.signal),
    );
  const compactor = new Compactor({
    summarizer: input.credentials.modelForCapability('fast'),
    limits,
    timeout: stepTimeout,
  });
  // Role-scoped usage sinks off the run's tracker (issue #114); undefined when no tracker, so each
  // init omits the seam. The fallback model id is the role's configured id, used when a response
  // doesn't echo modelId.
  const orchUsage = roleUsageSink(
    input.usage,
    'orchestrator',
    input.credentials.modelIdFor('orchestrator'),
  );
  const workerUsage = roleUsageSink(input.usage, 'worker', input.credentials.modelIdFor('worker'));
  const reviewerUsage = roleUsageSink(
    input.usage,
    'reviewer',
    input.credentials.modelIdFor('reviewer'),
  );

  const orch = new Orchestrator({
    credentials: input.credentials,
    agentConfig: input.agentConfig,
    ...(input.styleDigest !== undefined ? { styleDigest: input.styleDigest } : {}),
    rollingContext,
    github: input.github,
    ...(input.resolved.prBodySections !== undefined
      ? { prBodySections: input.resolved.prBodySections }
      : {}),
    timeout: stepTimeout,
    ...(orchUsage ? { onUsage: orchUsage } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    onProgress: (message) => harnessProgress(message),
  });

  // Build + run the Reviewer over a thread set in the given checkout. Wrapped by addressReviews
  // (which pushes the fixes), used by both the stage machine and the prPerTask autoMergeFlow. The
  // reviewer is recorded (issue #108) but never resumed — resume applies only to 'working'/'ci-failed'.
  // The per-thread conversations share one agent, so this records them into one transcript rather than one-per-thread.
  const runReviewerThreads = async ({ pr, threads, checkout }: ReviewerInvocation) => {
    const github = githubThreadTool({ github: input.github });
    // Surplus MCP tools beyond the fixed slots reach the Reviewer too, deferred above the threshold
    // (issue #119). The Reviewer's local `github` glue is a fixed slot, never deferred.
    const reviewerSurface = mcp.toolSurfaceForRole('reviewer');
    const reviewerMount = mountDeferredTools(reviewerSurface);
    const tools = applyHooks(
      {
        ...resolveReviewerTools(
          mcp.toolsForRole('reviewer'),
          checkout.path,
          github,
          input.resolved.bashRules,
          fetchHtmlAvailable,
          background,
        ),
        ...reviewerMount.extraTools,
      } as ReviewerTools,
      input,
      checkout.path,
    );
    const reviewerCompaction = buildCompactionStep<ReviewerTools>({
      compactor,
      modelId: input.credentials.modelIdFor('reviewer'),
      ...(input.logger ? { logger: input.logger } : {}),
    });
    const recorder = await beginTranscript(state.transcripts?.(), {
      group: checkout.groupId,
      stage: 'addressing-reviews',
    });
    const reviewerModelId = input.credentials.modelIdFor('reviewer');
    const reviewerCounter = stepCounter(checkout.groupId);
    harnessProgress(
      `group ${checkout.groupId}: addressing ${threads.length} review thread(s) on PR #${pr} with ${reviewerModelId}`,
      { phase: 'reviewing', ...reviewerCounter },
    );
    const session = buildSubagentSession<ReviewerTools>({
      role: 'reviewer',
      model: shortModelName(reviewerModelId),
      ctx: checkout.groupId,
      phase: 'reviewing',
      counter: reviewerCounter,
      streaming: input.resolved.streaming,
      recorder,
    });
    const agent = createReviewerAgent({
      model: input.credentials.modelFor('reviewer'),
      tools,
      systemPrompt: appendIndexBlock(
        reminderAgentSystemPrompt({
          style,
          roleGuidance: REVIEWER_SYSTEM_PREFIX,
          cwd: checkout.path,
          modelId: input.credentials.modelIdFor('reviewer'),
        }),
        reviewerMount.indexBlock,
      ),
      prepareStep:
        reviewerMount.activated === null
          ? reviewerCompaction
          : withActiveTools<ReviewerTools>(
              reviewerCompaction,
              tools,
              reviewerMount.deferredNames,
              reviewerMount.activated,
            ),
      timeout: stepTimeout,
      ...(reviewerUsage ? { onUsage: reviewerUsage } : {}),
      onStepFinish: session.onStepFinish,
      onRetry: session.onRetry,
      ...(session.onStream ? { onStream: session.onStream } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    // The review team (review-team.ts): a lead splits the threads and read-only investigators work
    // them out CONCURRENTLY before the sequential pass below starts writing. The resolution loop
    // itself stays serial by necessity — every "fixed" thread commits against this one shared
    // checkout — so the parallelism goes where it is safe: reading the code behind each comment.
    // Skipped for a single thread: there is no split to make, and the resolver reads it itself.
    const briefs =
      threads.length > 1
        ? await investigateReviewThreads({
            input,
            threads,
            checkoutPath: checkout.path,
            style,
            reviewerModelId,
            ...(reviewerUsage ? { reviewerUsage } : {}),
            mcp,
            fetchHtmlAvailable,
            counter: reviewerCounter,
          })
        : new Map<string, string>();
    const stopReviewerHeartbeat = session.start();
    let result: Awaited<ReturnType<typeof runReviewerSubagent>>;
    try {
      result = await runReviewerSubagent(agent, {
        pr,
        threads,
        checkoutPath: checkout.path,
        ...(briefs.size > 0 ? { briefs } : {}),
        // The single checkout is on the PR head branch (the PR was opened from it); pin it so a
        // review fix commit can never land on the wrong branch (audit 02, DECISION 1).
        headBranch: checkout.branch,
        styleContents: style,
        contextBlock: harnessContextBlock(),
        progressBlock: runProgressReminder(session.tag),
      });
    } finally {
      stopReviewerHeartbeat();
    }
    await recorder?.end(runEndOutcome(result.kind));
    // Report a summary of the review outcome with partial resolution count.
    if (result.kind === 'ok') {
      const partialCount = result.resolutions.filter((r) => r.kind === 'replied').length;
      const fixedCount = result.resolutions.filter((r) => r.kind === 'fixed').length;
      const wontfixCount = result.resolutions.filter((r) => r.kind === 'wontfix').length;
      if (fixedCount > 0 || partialCount > 0 || wontfixCount > 0) {
        const summary = [
          fixedCount > 0 && `${fixedCount} fixed`,
          partialCount > 0 && `${partialCount} partial`,
          wontfixCount > 0 && `${wontfixCount} wontfix`,
        ]
          .filter(Boolean)
          .join(', ');
        harnessProgress(
          `group ${checkout.groupId}: reviewed ${threads.length} thread(s) — ${summary}`,
          { phase: 'reviewing', ...reviewerCounter },
        );
      }
    }
    return result;
  };

  return {
    runWorker: async ({ group, task, checkout, baseBranch, signal }) => {
      // The WorkLoop passes the run's signal per invocation; fall back to the adapter's own so a
      // caller of this port that predates WorkerInvocation.signal still cancels. One expression for
      // both consumers below — the Coordinator agent and the editor fanout must abort together.
      const workerSignal = signal ?? input.signal;
      // Prefer MCP-supplied tools; partial-fill any the server omits from the local set so a
      // bare `aitm start` (no mcpServers configured) can still edit, commit and open a PR.
      // memory (#118) is mounted on the manifest Worker so it can record durable repo facts.
      // Surplus MCP tools beyond the fixed slots are mounted too (issue #119): directly below the
      // defer threshold, else name-only + `tool_search`.
      const workerSurface = mcp.toolSurfaceForRole('worker');
      const workerMount = mountDeferredTools(workerSurface);
      const tools = applyHooks(
        {
          ...resolveWorkerTools(
            mcp.toolsForRole('worker'),
            checkout.path,
            input.resolved.bashRules,
            fetchHtmlAvailable,
            buildExploreFor(input, checkout.path, workerUsage),
            memoryToolFor(state),
            background,
          ),
          ...workerMount.extraTools,
        } as WithExplore<WorkerTools> & WithMemory<WorkerTools>,
        input,
        checkout.path,
      );
      const workerCompaction = buildCompactionStep<WorkerTools>({
        compactor,
        modelId: input.credentials.modelIdFor('worker'),
        ...(input.logger ? { logger: input.logger } : {}),
      });
      const memoryIndex = await memoryIndexFor(state);
      // Transcript (issue #108): resume from an interrupted 'working' transcript for this group if one
      // exists — looked up BEFORE we begin the new one so it can't self-resume — then record this run.
      const store = state.transcripts?.();
      // In-memory carry-over wins over the durable transcript, same precedence as the CI-fix path: a
      // handle from earlier in THIS run is strictly fresher than a resumed one from a prior process.
      const carried = workerHandles.get(group.id);
      const resumeMessages = carried ?? (await resumeMessagesFor(store, group.id, 'working'));
      const recorder = await beginTranscript(store, { group: group.id, stage: 'working' });
      // Regular Worker: web_search only when explicitly enabled (webSearch: true).
      const providerOptions = webSearchProviderOptions(
        input.resolved.webSearch,
        false,
        input.resolved.baseURL,
      );
      const workerModelId = input.credentials.modelIdFor('worker');
      const workerModel = shortModelName(workerModelId);
      // Route this group/task to the target repo's best-matching domain specialist, if any. Its
      // guidance layers onto the Worker's base role prefix; no match → the base prefix, unchanged.
      const routed = selectSpecialistWithScore(
        await specialistRoster(),
        buildSpecialistSignal(group, task),
      );
      const specialist = routed?.agent ?? null;
      const session = buildSubagentSession<WorkerTools>({
        role: 'worker',
        model: workerModel,
        ctx: group.id,
        phase: 'working',
        counter: stepCounter(group.id, task),
        streaming: input.resolved.streaming,
        recorder,
        ...(specialist ? { specialist: specialist.name } : {}),
      });
      if (routed) {
        harnessProgress(
          `group ${group.id}: routing to '${routed.agent.name}' specialist (score ${routed.score})`,
          session.tag,
        );
      }
      // The group's acceptance check rides the role guidance (as the specialist's does): the Worker's
      // manifest prompt renders the title + task text only, so a check left on the PrGroup alone
      // would never reach the Coordinator that has to satisfy it. No check → the guidance is
      // byte-identical to before.
      const workerGuidance = withAcceptanceCheck(
        composeSpecialistGuidance(WORKER_SYSTEM_PREFIX, specialist),
        group.acceptance,
      );
      harnessProgress(
        `group ${group.id}: worker starting with ${workerModelId} — ${task ? task.text : group.title}`,
        session.tag,
      );
      const agent = createWorkerAgent({
        model: input.credentials.modelFor('worker'),
        tools,
        systemPrompt: appendIndexBlock(
          reminderAgentSystemPrompt({
            style,
            roleGuidance: workerGuidance,
            cwd: checkout.path,
            modelId: input.credentials.modelIdFor('worker'),
            memoryIndex,
          }),
          workerMount.indexBlock,
        ),
        prepareStep:
          workerMount.activated === null
            ? workerCompaction
            : withActiveTools<WorkerTools>(
                workerCompaction,
                tools,
                workerMount.deferredNames,
                workerMount.activated,
              ),
        timeout: stepTimeout,
        ...(providerOptions !== undefined ? { providerOptions } : {}),
        ...(workerUsage ? { onUsage: workerUsage } : {}),
        onStepFinish: session.onStepFinish,
        // Editor fanout runs on the worker model; per-step-field-only progress is parallel-safe.
        // Each leaf's `editorTag` (file/dir basename, issue #131) names the leaf in its own label.
        onEditorStepFinish: (editorTag) =>
          agentStepProgress(
            agentLabel({ model: workerModel, role: 'editor', ctx: group.id, file: editorTag }),
            session.tag,
          ),
        onRetry: session.onRetry,
        ...(session.onStream ? { onStream: session.onStream } : {}),
        ...(workerSignal ? { signal: workerSignal } : {}),
      });
      const stopWorkerHeartbeat = session.start();
      let result: Awaited<ReturnType<typeof runWorkerSubagent>>;
      try {
        result = await workerRunner(agent, {
          group,
          ...(task ? { task } : {}),
          checkoutPath: checkout.path,
          baseBranch,
          styleContents: style,
          // Live read (issue #123): the second group's manifest prompt carries the first group's digest.
          rollingContext: rollingCtx.current(),
          contextBlock: harnessContextBlock(),
          progressBlock: runProgressReminder(session.tag),
          ...(input.resolved.formatCommand ? { formatCommand: input.resolved.formatCommand } : {}),
          ...(input.resolved.verifyCommand ? { verifyCommand: input.resolved.verifyCommand } : {}),
          // One structured event per verify invocation reaches the run's logger (worker.ts).
          ...(input.logger ? { logger: input.logger } : {}),
          // Bound the editor fanout at the resolved cap (issue #189) — the one subagent knob, shared
          // with the scout survey. Always a number (config default SUBAGENT_LIMIT_DEFAULT), so passed
          // unconditionally.
          subagentLimit: input.resolved.subagentLimit,
          // Cancels the editor fanout: without it an abort stops the Coordinator's generation while
          // every editor leaf runs to completion, burning a fanout's worth of tokens on a dead run.
          ...(workerSignal ? { signal: workerSignal } : {}),
          // Resume (issue #108): continue the interrupted conversation from its retained messages
          // instead of cold-starting, reusing the #107 priorHandle continuation seam.
          ...(resumeMessages ? { priorHandle: { agent, messages: resumeMessages } } : {}),
        });
      } finally {
        stopWorkerHeartbeat();
      }
      // Carry this task's conversation to the group's next task. Only an `ok` result has a handle —
      // a blocked/no-changes pass leaves the previous carry-over in place rather than dropping the
      // group back to a cold start.
      if (result.kind === 'ok') workerHandles.set(group.id, [...result.handle.messages]);
      await recorder?.end(runEndOutcome(result.kind));
      return result;
    },
    finalizeCommit: (group, delivery, checkoutPath, taskId) =>
      orch.finalizeCommit(group, delivery, checkoutPath, taskId),
    openPr: async (group, delivery, baseBranch) => {
      const head = group.branch ?? `aitm/${group.id}`;
      const prOpenTag: RunStep = { phase: 'pr-open', ...stepCounter(group.id) };
      // Ground-truth emptiness check: a group whose tasks all completed without commits (declared
      // no-changes tasks) leaves the branch identical to the base — `gh pr create` would fail with
      // "No commits between …" and block a legitimately finished group. An unreadable count (probe
      // error) means unknown, not empty: fall through and let push/create surface any real problem.
      const ahead = await commitsAheadOfBase(input.cwd, baseBranch, head);
      if (ahead === 0) {
        harnessProgress(
          `group ${group.id}: ${head} adds no commits over ${baseBranch} — nothing to ship, skipping PR`,
          prOpenTag,
        );
        return 'nothing-to-ship';
      }
      // The Worker's commits live on the group branch in the local checkout. Push it to origin
      // first — `gh pr create` won't open a PR for a branch that isn't on the remote
      // ("No commits between … / Head ref must be a branch").
      harnessProgress(`group ${group.id}: pushing ${head} and opening PR`, prOpenTag);
      await runGit(['push', '--force-with-lease', '-u', 'origin', head], {
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const pr = await orch.openPr(group, delivery, baseBranch);
      harnessProgress(`group ${group.id}: PR #${pr.number} opened — ${pr.url}`, prOpenTag);
      // Accumulate this group's deterministic digest into the live rolling context and persist it
      // (issue #123), so the next group's Worker plans against it and a resumed run recovers it. The
      // accumulator serializes concurrent appends from a parallel group batch (no lost digest).
      await rollingCtx.append({ group, pr, delivery });
      return pr;
    },
    // Pre-PR self-review → shared self-review session: run the effective verify command once, then a
    // single adversarial review-and-fix Worker pass over the just-committed diff, committing any
    // fixes onto the group branch before the PR opens. Same subagent wiring as the CI-fix path (the
    // coding-tier Worker, compaction, usage, memory, rolling context), but on the LOCAL diff — no
    // rebase/force-push, since the PR isn't open yet. Verification is coordinator-owned: the session
    // runs the command; the Worker only commits.
    selfReview: async ({ group, checkout, baseBranch }) => {
      const selfReviewProviderOptions = webSearchProviderOptions(
        input.resolved.webSearch,
        false,
        input.resolved.baseURL,
      );
      // The self-review Worker runs on the coding tier, so its fallback model id is the coding id.
      const selfReviewUsage = roleUsageSink(
        input.usage,
        'worker',
        input.credentials.modelIdForCapability('coding'),
      );
      const selfReviewMemoryIndex = await memoryIndexFor(state);
      const selfReviewModelId = input.credentials.modelIdForCapability('coding');
      const selfReviewModel = shortModelName(selfReviewModelId);
      // Prefer the configured verifyCommand; else a conservative typecheck fallback for a TS repo.
      const verifyCommand = selfReviewVerifyCommand(input.resolved.verifyCommand, checkout.path);
      const session = buildSubagentSession<WorkerTools>({
        role: 'self-review',
        model: selfReviewModel,
        ctx: group.id,
        phase: 'self-review',
        counter: stepCounter(group.id),
        streaming: input.resolved.streaming,
      });
      harnessProgress(
        `group ${group.id}: self-reviewing the diff with ${selfReviewModelId} before opening the PR`,
        session.tag,
      );
      const stopSelfReviewHeartbeat = session.start();
      try {
        return await runSelfReviewSession({
          subagents: {
            credentials: input.credentials,
            workerTools: applyHooks(
              resolveWorkerTools(
                mcp.toolsForRole('worker'),
                checkout.path,
                input.resolved.bashRules,
                fetchHtmlAvailable,
                buildExploreFor(input, checkout.path, selfReviewUsage),
                memoryToolFor(state),
                background,
              ),
              input,
              checkout.path,
            ),
            styleContents: style,
            compactor,
            timeout: stepTimeout,
            contextBlock: harnessContextBlock(),
            progressBlock: runProgressReminder(session.tag),
            ...(selfReviewMemoryIndex.length > 0 ? { memoryIndex: selfReviewMemoryIndex } : {}),
            ...(rollingCtx.current().trim() !== '' ? { rollingContext: rollingCtx.current() } : {}),
            ...(selfReviewProviderOptions !== undefined
              ? { providerOptions: selfReviewProviderOptions }
              : {}),
            ...(selfReviewUsage ? { onUsage: selfReviewUsage } : {}),
            ...(input.resolved.formatCommand
              ? { formatCommand: input.resolved.formatCommand }
              : {}),
            onStepFinish: session.onStepFinish,
            onEditorStepFinish: (editorTag) =>
              agentStepProgress(
                agentLabel({
                  model: selfReviewModel,
                  role: 'editor',
                  ctx: group.id,
                  file: editorTag,
                }),
                session.tag,
              ),
            onRetry: session.onRetry,
            ...(session.onStream ? { onStream: session.onStream } : {}),
          },
          group,
          baseBranch,
          checkoutPath: checkout.path,
          ...(verifyCommand ? { verifyCommand } : {}),
          ...(input.logger ? { logger: input.logger } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } finally {
        stopSelfReviewHeartbeat();
      }
    },
    // ci-failed stage → shared fix session: download failed logs + comments to the state dir, run
    // the coding-capability Worker pointed at them, rebase onto origin/<base>, force-with-lease push.
    runCiFix: async ({ group, pr, checkout, baseBranch }) => {
      const priorHandle = ciFixHandles.get(group.id);
      const ciFixProviderOptions = webSearchProviderOptions(
        input.resolved.webSearch,
        true,
        input.resolved.baseURL,
      );
      // The CI-fix Worker runs on the coding tier, so its fallback model id is the coding id.
      const ciFixUsage = roleUsageSink(
        input.usage,
        'worker',
        input.credentials.modelIdForCapability('coding'),
      );
      const ciFixMemoryIndex = await memoryIndexFor(state);
      // Transcript (issue #108): resume an interrupted ci-fix transcript when no in-memory handle
      // survived (fresh process), and record this fix pass. Look up before begin so it can't
      // self-resume; the in-memory priorHandle still wins over a transcript inside ci-fix.
      const ciStore = state.transcripts?.();
      const ciResume = priorHandle ? null : await resumeMessagesFor(ciStore, group.id, 'ci-failed');
      const ciRecorder = await beginTranscript(ciStore, { group: group.id, stage: 'ci-failed' });
      const ciFixModelId = input.credentials.modelIdForCapability('coding');
      const ciFixModel = shortModelName(ciFixModelId);
      harnessProgress(
        `group ${group.id}: CI failed on PR #${pr} — running fix session with ${ciFixModelId}`,
        { phase: 'ci-fix', ...stepCounter(group.id) },
      );
      const session = buildSubagentSession<WorkerTools>({
        role: 'ci-fix',
        model: ciFixModel,
        ctx: group.id,
        phase: 'ci-fix',
        counter: stepCounter(group.id),
        streaming: input.resolved.streaming,
        recorder: ciRecorder,
      });
      const ciFixWorkerTools = applyHooks(
        resolveWorkerTools(
          mcp.toolsForRole('worker'),
          checkout.path,
          input.resolved.bashRules,
          fetchHtmlAvailable,
          buildExploreFor(input, checkout.path, ciFixUsage),
          memoryToolFor(state),
          background,
        ),
        input,
        checkout.path,
      );
      // AI conflict resolution (default-on): reuse the coding-tier model + the same Worker tool
      // surface to resolve a rebase conflict before the group blocks. Gated by config.
      const ciFixResolveConflicts = input.resolved.resolveConflicts
        ? buildConflictResolver({
            model: input.credentials.modelForCapability('coding'),
            tools: ciFixWorkerTools,
            styleContents: style,
            timeout: stepTimeout,
            ...(ciFixProviderOptions !== undefined
              ? { providerOptions: ciFixProviderOptions }
              : {}),
            ...(ciFixUsage ? { onUsage: ciFixUsage } : {}),
            onStepFinish: agentStepProgress(
              agentLabel({ model: ciFixModel, role: 'conflict-resolve', ctx: group.id }),
              session.tag,
            ),
            ...(input.logger ? { logger: input.logger } : {}),
          })
        : undefined;
      const stopCiFixHeartbeat = session.start();
      let result: Awaited<ReturnType<typeof runFixSession>>;
      try {
        result = await runFixSession({
          github: input.github,
          prContext: new PrContextStore(resolvePath(input.cwd, '.ai-task-master')),
          subagents: {
            credentials: input.credentials,
            workerTools: ciFixWorkerTools,
            styleContents: style,
            compactor,
            timeout: stepTimeout,
            // Memory index for the fix session's Worker (issue #118); it also records CI facts it learns.
            ...(ciFixMemoryIndex.length > 0 ? { memoryIndex: ciFixMemoryIndex } : {}),
            // Live rolling context (issue #123): the fix session's Worker sees what its group shipped
            // instead of the old hardcoded ''. Omitted when empty so the render guard stays a no-op.
            ...(rollingCtx.current().trim() !== '' ? { rollingContext: rollingCtx.current() } : {}),
            // CI-fix Worker: web_search on by default (undefined) — a fix pass looking up an error or
            // changelog is the highest-value place for it; only an explicit `false` disables it.
            ...(ciFixProviderOptions !== undefined
              ? { providerOptions: ciFixProviderOptions }
              : {}),
            // CI-fix Worker usage recorded under `worker`; it runs on the coding-tier model (#114).
            ...(ciFixUsage ? { onUsage: ciFixUsage } : {}),
            ...(input.resolved.formatCommand
              ? { formatCommand: input.resolved.formatCommand }
              : {}),
            ...(input.resolved.verifyCommand
              ? { verifyCommand: input.resolved.verifyCommand }
              : {}),
            onStepFinish: session.onStepFinish,
            onEditorStepFinish: (editorTag) =>
              agentStepProgress(
                agentLabel({ model: ciFixModel, role: 'editor', ctx: group.id, file: editorTag }),
                session.tag,
              ),
            onRetry: session.onRetry,
            ...(session.onStream ? { onStream: session.onStream } : {}),
            ...(ciResume ? { resumeMessages: ciResume } : {}),
            ...(ciFixResolveConflicts ? { resolveConflicts: ciFixResolveConflicts } : {}),
          },
          group,
          pr,
          baseBranch,
          checkoutPath: checkout.path,
          allowForcePush: input.resolved.allowForcePush,
          ...(priorHandle ? { priorHandle } : {}),
          ...(input.logger ? { logger: input.logger } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } finally {
        stopCiFixHeartbeat();
      }
      await ciRecorder?.end(result.kind === 'fixed' ? 'submitted' : 'no-submission');
      if (result.kind === 'fixed') {
        // Retain this pass's conversation so the next fix pass for the group continues it (#107).
        ciFixHandles.set(group.id, result.handle);
        return { kind: 'ok' };
      }
      return { kind: 'blocked', reason: result.reason };
    },
    // addressing-reviews stage → run the Reviewer, then push its commits so the PR updates. The
    // Reviewer commits code fixes locally (worker pattern) on top of the PR branch (which a prior
    // CI-fix rebase may have rewritten, so the push needs --force-with-lease, never plain push).
    // Do NOT fetch before the lease push: the lease's expected value is our remote-tracking ref, so
    // fetching first would refresh it to the current remote tip and clobber any commit pushed to the
    // PR branch while the Reviewer ran — exactly what the lease is meant to refuse. Replied/wontfix-
    // only rounds make no commit, so there's nothing to push.
    addressReviews: async ({ pr, threads, checkout }) => {
      const result = await runReviewerThreads({ pr, threads, checkout });
      if (result.kind !== 'ok') {
        return {
          kind: 'blocked',
          reason: result.kind === 'blocked' ? result.reason : result.error,
        };
      }
      if (result.resolutions.some((r) => r.kind === 'fixed')) {
        if (!input.resolved.allowForcePush) {
          return {
            kind: 'blocked',
            reason:
              'review fixes are committed locally but force-push is disabled by policy ' +
              '(allowForcePush=false); push the PR branch manually.',
          };
        }
        try {
          // runGit throws (execa reject) on a non-zero exit — a failed lease (someone else pushed)
          // or any push error surfaces here as a blocked reason rather than crashing the run.
          await runGit(['push', '--force-with-lease'], {
            cwd: checkout.path,
            allowForcePush: input.resolved.allowForcePush,
            ...(input.signal ? { signal: input.signal } : {}),
          });
        } catch (err) {
          return {
            kind: 'blocked',
            reason: `unable to push review fixes: ${describeError(err).message}`,
          };
        }
      }
      return { kind: 'ok' };
    },
    // Drop the group's carried conversations once the WorkLoop is done with it. Both maps hold whole
    // ModelMessage[] histories — the largest per-group allocation the run makes — and a finished group
    // is never rescheduled, so keeping them is pure accumulation across a many-group run.
    releaseGroup: (groupId) => {
      workerHandles.delete(groupId);
      ciFixHandles.delete(groupId);
    },
  };
}

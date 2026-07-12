// Production wiring for `aitm start`. Composes the WorkLoop's structural ports out of the
// real Planner, Orchestrator, WorktreePool, PlanGraph, MCP tools and GitHubClient.
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

import { relative, resolve as resolvePath } from 'node:path';
import {
  type AgentToolInput,
  bashTool,
  type CommandRule,
  contextReminder,
  editFileTool,
  FileStateTracker,
  globTool,
  grepTool,
  loadMemoryIndex,
  type MemoryIndexEntry,
  multiBashTool,
  multiEditTool,
  type ReminderProvider,
  readFileTool,
  type SubagentHandle,
  SYSTEM_REMINDER_CONTRACT,
  type ToolHooks,
  withHooks,
  withReminders,
  writeFileTool,
} from '@developerz.ai/ai-claude-compat';
import { type Tool, type ToolSet, tool } from 'ai';
import { z } from 'zod';
// Type-only import — no runtime cycle with commands.ts, which imports this module's value.
import type { RunLoopInput } from '../cli/commands.ts';
import { buildCompactionStep } from '../compaction/compaction-step.ts';
import { Compactor } from '../compaction/compactor.ts';
import type { GitHubClient } from '../github/github-client.ts';
import { McpClientManager } from '../mcp/mcp-client.ts';
import { roleUsageSink } from '../observability/usage-tracker.ts';
import { OpenRouterClient } from '../openrouter/client.ts';
import { ModelLimitsRegistry } from '../openrouter/model-limits.ts';
import { providerOptionsWithServerTools, webSearchTool } from '../openrouter/server-tools.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { PlanGraph } from '../plan/plan-graph.ts';
import type { PlanMarkdownGroup } from '../plan/plan-markdown.ts';
import type { Plan } from '../plan/schema.ts';
import { PrContextStore } from '../state/pr-context-store.ts';
import { appendGroupDigest, type GroupDigestEntry } from '../state/rolling-context.ts';
import type { PrGroup, RunState } from '../state/schema.ts';
import { buildExploreTool } from '../subagents/explore.ts';
import { buildMemoryTool, type MemoryToolInput } from '../subagents/memory-tool.ts';
import {
  createPlannerAgent,
  PLANNER_MAX_STEPS,
  PLANNER_SYSTEM_PREFIX,
  type PlannerTools,
  runPlanner,
} from '../subagents/planner.ts';
import {
  createReviewerAgent,
  type GithubToolInput,
  type GithubToolOutput,
  REVIEWER_MAX_STEPS,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerTools,
  runReviewer as runReviewerSubagent,
} from '../subagents/reviewer.ts';
import { buildRolePrompt, type RolePromptInput } from '../subagents/role-prompt.ts';
import {
  createWorkerAgent,
  runWorker as runWorkerSubagent,
  WORKER_MAX_STEPS,
  WORKER_SYSTEM_PREFIX,
  type WorkerTools,
} from '../subagents/worker.ts';
import { datetimeTool } from '../tools/datetime.ts';
import { type FetchHtmlInput, fetchHtmlTool, isFetchHtmlAvailable } from '../tools/fetch-html.ts';
import { type WebFetchOutput, webFetchTool } from '../tools/web-fetch.ts';
import { runGit } from '../workspace/git-exec.ts';
import { WorktreePool } from '../workspace/worktree-pool.ts';
import { runFixSession } from './ci-fix.ts';
import { hasInterruptedGroup, normalizeResumeStatus } from './resume-normalize.ts';
import {
  type ReviewerInvocation,
  WorkLoop,
  type WorkLoopGithub,
  type WorkLoopGraph,
  type WorkLoopOrchestrator,
  type WorkLoopResult,
  type WorkLoopState,
} from './work-loop.ts';

// Worktree-scoped Claude-Code-style tools the Worker/Reviewer fall back to when no MCP server
// supplies them. aitm is MCP-first, but a bare `aitm start` (no `mcpServers` configured) must
// still be able to read, search, edit, commit and open a PR — so it uses the compat lib's
// tools, scoped to the active worktree.
// A reminder provider that surfaces the tracker's stale set on a file tool's result (issue #106): a
// file changed on disk since the model read it yields one file-changed-externally note on the next
// successful file-tool result. Shared by localEditTools and localReadTools.
function makeStaleReminderProvider(fileState: FileStateTracker, cwd: string): ReminderProvider {
  return () => staleFileReminders(fileState, cwd);
}

// fetchHtml is a RUNTIME-ONLY extra on the core tool sets: an optional tool *field* on a ToolLoopAgent
// generic injects `undefined` into the SDK's TypedToolCall union (issue #112), so it never sits on
// WorkerTools/PlannerTools. The local builders return the core set plus this optional extra; the
// model still gets the tool at runtime, and resolvers cast back to the core type.
type WithFetchHtml<T> = T & { fetchHtml?: Tool<FetchHtmlInput, WebFetchOutput> };

// `explore` (issue #126) is a runtime-only extra for the same reason as fetchHtml: an optional tool
// field on WorkerTools/PlannerTools would inject `undefined` into the ToolLoopAgent TypedToolCall
// union (#112). It sits here so the core tool types stay unchanged — every record built without it
// (take-over flow, orchestrator-as-tool, test stubs) compiles and behaves exactly as today.
type WithExplore<T> = T & { explore?: Tool<AgentToolInput, string> };

// `memory` (issue #118) is a runtime-only extra for the same reason: it needs the StateStore memory
// dir (state context compat's local builders don't have), and a static optional field would trip the
// #112 TypedToolCall union. Present on the Worker set only when the state port hands out a memory dir.
type WithMemory<T> = T & { memory?: Tool<MemoryToolInput, string> };

// The worktree-confined read-only trio the explore child surveys with — picked from localReadTools
// so it inherits the same resolveInside confinement, minus the web/datetime tools (the child's
// allowlist is readFile/grep/glob only). Rooted at the invoking agent's cwd/worktree.
export function exploreReadTools(cwd: string): ToolSet {
  const read = localReadTools(cwd);
  return { readFile: read.readFile, grep: read.grep, glob: read.glob };
}

// The explore tool for an agent rooted at `cwd`: a fast-tier child surveying the worktree-confined
// read trio (issue #126). Built per call site (Planner at the repo root, Worker at its group
// worktree) so the child never escapes the invoking agent's cwd.
function buildExploreFor(input: RunLoopInput, cwd: string): Tool<AgentToolInput, string> {
  return buildExploreTool({
    model: input.credentials.modelForCapability('fast'),
    readTools: exploreReadTools(cwd),
  });
}

// The Worker's `memory` tool (issue #118), rooted at the state port's memory dir. Undefined when the
// port hands out no dir (test stubs), so memory features stay entirely off with no scaffold.
function memoryToolFor(
  state: Pick<AdapterStatePort, 'memoryDir'>,
): Tool<MemoryToolInput, string> | undefined {
  const dir = state.memoryDir?.();
  return dir ? buildMemoryTool(dir) : undefined;
}

// Load the current memory index for prompt injection (issue #118). Read fresh per prompt build so a
// memory a Worker wrote in an earlier group is visible to the next. Empty when no memory dir.
async function memoryIndexFor(
  state: Pick<AdapterStatePort, 'memoryDir'>,
): Promise<MemoryIndexEntry[]> {
  const dir = state.memoryDir?.();
  return dir ? loadMemoryIndex(dir) : [];
}

// Apply operator-configured PreToolUse/PostToolUse hooks over a resolved tool record (issue #121),
// after the MCP/local partial-fill so both MCP-supplied and local tools are covered. No hooks
// configured → the record is returned untouched. Exported for tests.
export function applyHooks<T extends ToolSet>(tools: T, input: RunLoopInput, cwd: string): T {
  // The zod-inferred config type spells optional fields as `T | undefined`; withHooks reads them
  // with `?? []`, so the shapes are runtime-identical — the cast only reconciles exactOptional.
  const hooks = input.resolved.hooks as ToolHooks | undefined;
  return hooks ? withHooks(tools, hooks, { cwd }) : tools;
}

// Web + time function tools mounted into every subagent tool set (issue #112). webFetch (stealthed
// local fetch, SSRF-guarded) and datetime are always present; fetchHtml (curl-impersonate) only when
// its binary is available.
function webFunctionTools(
  fetchHtmlAvailable: boolean,
): WithFetchHtml<Pick<WorkerTools, 'webFetch' | 'datetime'>> {
  return {
    webFetch: webFetchTool(),
    datetime: datetimeTool(),
    ...(fetchHtmlAvailable ? { fetchHtml: fetchHtmlTool() } : {}),
  };
}

export function localEditTools(
  cwd: string,
  rules?: readonly CommandRule[],
  fetchHtmlAvailable = false,
): WithFetchHtml<WorkerTools> {
  // One FileStateTracker per tool set (per subagent invocation) so read-before-edit enforcement is
  // scoped to a single run — the four file tools share it (issue #104).
  const fileState = new FileStateTracker();
  const staleReminders = makeStaleReminderProvider(fileState, cwd);
  // Deny/allow governance on the model-facing shell (issue #113). Omitted → no governance.
  const bashInit = rules ? { cwd, rules: [...rules] } : { cwd };
  return {
    readFile: withReminders(readFileTool({ cwd, fileState }), staleReminders),
    writeFile: withReminders(writeFileTool({ cwd, fileState }), staleReminders),
    editFile: withReminders(editFileTool({ cwd, fileState }), staleReminders),
    multiEdit: withReminders(multiEditTool({ cwd, fileState }), staleReminders),
    grep: grepTool({ cwd }),
    glob: globTool({ cwd }),
    bash: bashTool(bashInit),
    multiBash: multiBashTool(bashInit),
    ...webFunctionTools(fetchHtmlAvailable),
  };
}

// Read-only subset for the Planner — survey the repo without write/edit/bash (plus the web tools).
export function localReadTools(
  cwd: string,
  fetchHtmlAvailable = false,
): WithFetchHtml<PlannerTools> {
  const fileState = new FileStateTracker();
  const staleReminders = makeStaleReminderProvider(fileState, cwd);
  return {
    readFile: withReminders(readFileTool({ cwd, fileState }), staleReminders),
    grep: grepTool({ cwd }),
    glob: globTool({ cwd }),
    ...webFunctionTools(fetchHtmlAvailable),
  };
}

// One file-changed-externally reminder per path the tracker (#104) has flagged stale — a file whose
// on-disk content diverged from what the model read. Paths are stored absolute; surface them
// repo-relative. Empty until a stale-read check flags one (e.g. an edit against a since-changed file).
function staleFileReminders(fileState: FileStateTracker, cwd: string): string[] {
  return fileState
    .staleFiles()
    .map(
      (abs) =>
        `${relative(cwd, abs)} was modified on disk since you last read it — your cached view is stale. Re-read it before editing.`,
    );
}

// First-message context block for the subagents: the target-repo instructions + today's date, framed
// as advisory <system-reminder> context (issue #106). Prepended to each subagent's first user message.
export function harnessContextBlock(styleContents: string): string {
  return contextReminder([
    { label: 'claudeMd', body: styleContents },
    { label: 'currentDate', body: new Date().toISOString().slice(0, 10) },
  ]);
}

// System prompt for a main-loop agent whose tool set is decorated with reminders (issue #106): the
// role's block-pipeline prompt (issue #105) plus the provenance contract, so the model treats
// <system-reminder> content as advisory harness context, not user intent.
export function reminderAgentSystemPrompt(input: RolePromptInput): string {
  return `${buildRolePrompt(input)}\n\n${SYSTEM_REMINDER_CONTRACT}`;
}

// Narrow state surface the adapter drives. StateStore satisfies it; tests pass an in-memory stub.
// readContext is optional — the rolling summary of prior PRs is threaded into subagent prompts
// when present, and the run still works (empty context) when the port omits it.
export type AdapterStatePort = {
  read(): Promise<RunState>;
  update(mutator: (s: RunState) => RunState): Promise<RunState>;
  readContext?(): Promise<string | null>;
  // Persist the accumulated rolling context (context.md) after each PR opens (issue #123). Optional
  // like readContext; StateStore satisfies it verbatim (atomic write), test stubs may omit it.
  writeContext?(summary: string): Promise<void>;
  // Persist plan groups as the loop marks tasks done; StateStore renders them to plan.md.
  // Optional so in-memory test stubs can omit it; StateStore supplies it in production.
  writePlan?(groups: readonly PlanMarkdownGroup[]): Promise<void>;
  // The per-repo memory dir (issue #118). Optional: a port that omits it turns memory off entirely
  // (no index block, no memory tool). StateStore supplies it in production.
  memoryDir?(): string;
};

// Append one group's digest to the live rolling context and persist it (issue #123). Failure-tolerant:
// a writeContext rejection is warned to stderr, never propagated — persisting context must never fail
// the PR-open path (the PR is already open; a lost digest only costs the next group some freshness).
export async function persistRollingContext(
  state: Pick<AdapterStatePort, 'writeContext'>,
  liveContext: string,
  entry: GroupDigestEntry,
): Promise<string> {
  const next = appendGroupDigest(liveContext, entry);
  try {
    await state.writeContext?.(next);
  } catch (err) {
    process.stderr.write(
      `warning: failed to persist rolling context: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return next;
}

// Serialized rolling-context accumulator (issue #123). WorkLoop opens a whole batch of groups with
// `Promise.all`, so two openPr callbacks can run persistRollingContext concurrently. A plain
// read-modify-write of a shared string would lose an update — both appends start from the same
// snapshot and the later write clobbers the earlier group's digest. Queue every append onto a chain
// so each one reads the context left by the previous append; `current()` always returns the newest
// accumulated context for the worker + ci-fix live reads. Exported for unit testing.
export type RollingContextAccumulator = {
  current(): string;
  append(entry: GroupDigestEntry): Promise<string>;
};

export function createRollingContextAccumulator(
  state: Pick<AdapterStatePort, 'writeContext'>,
  initial: string,
): RollingContextAccumulator {
  let liveContext = initial;
  // Tail of the serialization chain. Its rejections are swallowed (persistRollingContext already
  // absorbs write failures) so one bad append can never wedge the queue for later groups.
  let tail: Promise<unknown> = Promise.resolve();
  return {
    current: () => liveContext,
    append: (entry) => {
      const step = tail.then(async () => {
        liveContext = await persistRollingContext(state, liveContext, entry);
        return liveContext;
      });
      tail = step.catch(() => undefined);
      return step;
    },
  };
}

export type PlanGroupsOutcome =
  | { kind: 'ok'; groups: PrGroup[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

export type OrchestratorBridgeCtx = {
  input: RunLoopInput;
  mcp: McpClientManager;
  rollingContext: string;
  // Whether the curl-impersonate binary is present, resolved once per run (isFetchHtmlAvailable is
  // async; the orchestrator builder is sync). Gates the optional fetchHtml tool (issue #112).
  fetchHtmlAvailable: boolean;
  // State port so the bridge can persist the accumulated rolling context after each PR opens (#123).
  state: AdapterStatePort;
};

export type RunLoopAdapterSeams = {
  planGroups?: (
    input: RunLoopInput,
    mcp: McpClientManager,
    fetchHtmlAvailable: boolean,
  ) => Promise<PlanGroupsOutcome>;
  makeOrchestrator?: (
    ctx: OrchestratorBridgeCtx,
  ) => WorkLoopOrchestrator | Promise<WorkLoopOrchestrator>;
  makePool?: (input: RunLoopInput) => WorkLoopPool;
  makeGithub?: (input: RunLoopInput) => WorkLoopGithub;
  makeMcp?: (input: RunLoopInput) => McpClientManager;
  state?: AdapterStatePort;
};

// Re-exported for the seam type below without re-importing WorkLoopPool everywhere.
export type WorkLoopPool = import('./work-loop.ts').WorkLoopPool;

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
      });

  let mcpConnected = false;
  try {
    if (usesMcp && !seams.makeMcp) {
      await mcp.connectAll();
      mcpConnected = true;
    }

    const current = await state.read();
    const rollingContext = (await state.readContext?.()) ?? '';

    // Resolve ONCE per run (a subprocess probe): the fetchHtml tool is mounted only when the
    // curl-impersonate binary is present. Threaded into both the Planner (planGroups) and the sync
    // orchestrator builder so the probe never runs twice (issue #112).
    const fetchHtmlAvailable = await isFetchHtmlAvailable();

    // ---- Plan (fresh) or resume (prior prGroups present) -------------------
    let groups: PrGroup[];
    if (current.prGroups.length > 0) {
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
      const outcome = await planFn(input, mcp, fetchHtmlAvailable);
      if (outcome.kind === 'blocked') {
        return { kind: 'blocked', reason: outcome.reason, outcomes: [] };
      }
      if (outcome.kind === 'error') {
        return { kind: 'blocked', reason: `planner error: ${outcome.error}`, outcomes: [] };
      }
      if (outcome.groups.length === 0) {
        return { kind: 'blocked', reason: 'planner produced no PR groups', outcomes: [] };
      }
      groups = outcome.groups;
      await state.update((s) => ({ ...s, status: 'working', prGroups: groups }));
    }

    // ---- Live graph + state proxy ------------------------------------------
    // PlanGraph captures its groups at construction, so rebuild it per call against the
    // mirror that workLoopState keeps in sync after every persisted update.
    let liveGroups: readonly PrGroup[] = groups;
    const graph: WorkLoopGraph = {
      ready: () => new PlanGraph([...liveGroups]).ready(),
      isComplete: () => new PlanGraph([...liveGroups]).isComplete(),
    };
    const workLoopState: WorkLoopState = {
      update: async (mutator) => {
        const next = await state.update(mutator);
        liveGroups = next.prGroups;
        return next;
      },
      writePlan: async (groups) => {
        await state.writePlan?.(groups);
      },
    };

    // ---- Remaining deps ----------------------------------------------------
    const pool =
      seams.makePool?.(input) ??
      new WorktreePool(
        input.cwd,
        resolvePath(input.cwd, '.ai-task-master'),
        input.resolved.concurrency,
      );
    const github = seams.makeGithub?.(input) ?? input.github;
    const orchestrator = await (seams.makeOrchestrator ?? defaultMakeOrchestrator)({
      input,
      mcp,
      rollingContext,
      fetchHtmlAvailable,
      state,
    });

    const loop = new WorkLoop({
      orchestrator,
      github,
      state: workLoopState,
      pool,
      graph,
      // Persist addressed review threads so the addressing-reviews loop dedups across re-polls.
      prContext: new PrContextStore(resolvePath(input.cwd, '.ai-task-master')),
      concurrency: input.resolved.concurrency,
      autoMerge: input.resolved.autoMerge,
      prPerTask: current.options.prPerTask ?? false,
      maxSessions: input.resolved.maxSessions,
      maxCiFixAttempts: input.resolved.maxCiFixAttempts,
      mergeMethod: input.resolved.mergeMethod,
      adminMerge: input.resolved.adminMerge ?? false,
      initialSessionCount: current.sessionCount,
    });
    return await loop.run();
  } finally {
    if (mcpConnected) {
      await mcp.close();
    }
  }
}

// ---- Plan ------------------------------------------------------------------

// Normalize a Planner-supplied group id into a safe git ref component. The id is only
// `z.string()` in the plan schema, so it can carry characters (leading '.', '.lock', spaces,
// ':' …) that would make `aitm/<id>` or `<branch>/<id>` an invalid ref and fail at worktree
// creation. Map unsafe chars to '-', strip the component-level footguns, never return empty.
export function sanitizeBranchComponent(id: string): string {
  let s = id.replace(/[^A-Za-z0-9._-]/g, '-');
  s = s.replace(/\.\.+/g, '.'); // collapse '..' (forbidden in refs)
  s = s.replace(/^[.-]+/, ''); // no leading '.' or '-'
  s = s.replace(/(?:\.lock)+$/i, ''); // no trailing '.lock'
  s = s.replace(/[.-]+$/, ''); // no trailing '.' or '-'
  return s.length > 0 ? s : 'group';
}

// Resolve a group's branch name, honoring a caller-specified `--branch`.
//   - no branch requested        → `aitm/<group-id>` (default)
//   - requested, single group    → the requested name verbatim (already validated by the CLI)
//   - requested, multiple groups → `<requested>/<group-id>` so concurrent worktrees
//     (and the PRs they open) don't collide on one branch name.
// The group-id segment is always sanitized so the composed ref is valid regardless of what the
// Planner emitted.
export function branchFor(
  groupId: string,
  requested: string | undefined,
  totalGroups: number,
): string {
  const safeId = sanitizeBranchComponent(groupId);
  if (requested === undefined) return `aitm/${safeId}`;
  return totalGroups <= 1 ? requested : `${requested}/${safeId}`;
}

export function planToPrGroups(plan: Plan, branch?: string): PrGroup[] {
  const total = plan.groups.length;
  return plan.groups.map((g) => ({
    id: g.id,
    title: g.title,
    tasks: g.tasks.map((t, i) => ({
      id: `${g.id}-${i + 1}`,
      text: t.description,
      complexity: t.complexity,
      done: false,
    })),
    dependsOn: g.dependsOn,
    branch: branchFor(g.id, branch, total),
    pr: null,
    status: 'pending' as const,
    stage: 'pending' as const,
  }));
}

async function defaultPlanGroups(
  input: RunLoopInput,
  mcp: McpClientManager,
  fetchHtmlAvailable: boolean,
): Promise<PlanGroupsOutcome> {
  const style = input.styleDigest ?? input.agentConfig.contents;
  const plannerUsage = roleUsageSink(
    input.usage,
    'planner',
    input.credentials.modelIdFor('planner'),
  );
  // Planner gets the memory index (issue #118) but no memory tool: its read tools are rooted at the
  // repo cwd, so it reads memory files directly and stays read-only.
  const memoryIndex = await memoryIndexFor(input.state);
  const agent = createPlannerAgent({
    model: input.credentials.modelFor('planner'),
    tools: applyHooks(
      resolvePlannerTools(
        mcp.toolsForRole('planner'),
        input.cwd,
        fetchHtmlAvailable,
        buildExploreFor(input, input.cwd),
      ),
      input,
      input.cwd,
    ),
    systemPrompt: reminderAgentSystemPrompt({
      style,
      roleGuidance: PLANNER_SYSTEM_PREFIX,
      cwd: input.cwd,
      maxSteps: PLANNER_MAX_STEPS,
      modelId: input.credentials.modelIdFor('planner'),
      memoryIndex,
    }),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(plannerUsage ? { onUsage: plannerUsage } : {}),
  });
  const result = await runPlanner(agent, {
    goal: input.goal,
    styleContents: style,
    maxPrs: input.resolved.maxPrs,
    contextBlock: harnessContextBlock(style),
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
  });
  if (result.kind === 'ok')
    return { kind: 'ok', groups: planToPrGroups(result.plan, input.branch) };
  if (result.kind === 'blocked') return { kind: 'blocked', reason: result.reason };
  return { kind: 'error', error: result.error };
}

// ---- Orchestrator bridge ---------------------------------------------------

// web_search server-tool gating (issue #112). webSearch undefined → CI-fix sessions only (highest
// lookup value, bounded cost); true → all Worker calls; false → never. Returns the providerOptions
// fragment (openrouter namespace) or undefined when web_search should not attach. Exported for tests.
export function webSearchProviderOptions(
  webSearch: boolean | undefined,
  ciFix: boolean,
): ReturnType<typeof providerOptionsWithServerTools> | undefined {
  const enabled = webSearch === true || (ciFix && webSearch !== false);
  return enabled ? providerOptionsWithServerTools([webSearchTool()]) : undefined;
}

export function defaultMakeOrchestrator(ctx: OrchestratorBridgeCtx): WorkLoopOrchestrator {
  const { input, mcp, rollingContext, fetchHtmlAvailable, state } = ctx;
  // Rolling context accumulates across groups within a run (issue #123): seeded from what a resumed
  // run already persisted (ctx.rollingContext), grown by openPr after each PR, and read LIVE by the
  // worker + ci-fix bridges — so group N+1 plans against group N's digest. Appends are serialized so
  // the concurrent-batch openPr path (WorkLoop's Promise.all) can't lose a group's digest.
  const rollingCtx = createRollingContextAccumulator(state, rollingContext);
  const style = input.styleDigest ?? input.agentConfig.contents;
  // Per-step LLM deadline armed on every generate site in this bridge (issue #129).
  const stepTimeout = { stepMs: input.resolved.llmStepTimeoutMs };

  // Per-group CI-fix conversation handles, retained in memory for the life of the run so successive
  // fix passes for a group continue the same Worker conversation instead of re-planning cold — the
  // Worker remembers what earlier passes already tried (issue #107). Never shared across groups; not
  // persisted (a crash falls back to a cold start — durable transcripts are #108).
  const ciFixHandles = new Map<string, SubagentHandle<WorkerTools>>();

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
      new OpenRouterClient(input.resolved.openrouterApiKey, input.resolved.baseURL),
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
    maxSessions: input.resolved.maxSessions,
    github: input.github,
    ...(input.resolved.prBodySections !== undefined
      ? { prBodySections: input.resolved.prBodySections }
      : {}),
    timeout: stepTimeout,
    ...(orchUsage ? { onUsage: orchUsage } : {}),
  });

  // Build + run the Reviewer over a thread set in the given worktree. Shared by the prPerTask
  // autoMergeFlow (runReviewer) and the stage machine (addressReviews).
  const runReviewerThreads = ({ pr, threads, worktree }: ReviewerInvocation) => {
    const github = githubThreadTool(input.github);
    const tools = applyHooks(
      resolveReviewerTools(
        mcp.toolsForRole('reviewer'),
        worktree.path,
        github,
        input.resolved.bashRules,
        fetchHtmlAvailable,
      ),
      input,
      worktree.path,
    );
    const agent = createReviewerAgent({
      model: input.credentials.modelFor('reviewer'),
      tools,
      systemPrompt: reminderAgentSystemPrompt({
        style,
        roleGuidance: REVIEWER_SYSTEM_PREFIX,
        cwd: worktree.path,
        maxSteps: REVIEWER_MAX_STEPS,
        modelId: input.credentials.modelIdFor('reviewer'),
      }),
      prepareStep: buildCompactionStep<ReviewerTools>({
        compactor,
        modelId: input.credentials.modelIdFor('reviewer'),
      }),
      timeout: stepTimeout,
      ...(reviewerUsage ? { onUsage: reviewerUsage } : {}),
    });
    return runReviewerSubagent(agent, {
      pr,
      threads,
      worktreePath: worktree.path,
      styleContents: style,
      contextBlock: harnessContextBlock(style),
    });
  };

  return {
    runWorker: async ({ group, task, worktree, baseBranch }) => {
      // Prefer MCP-supplied tools; partial-fill any the server omits from the local set so a
      // bare `aitm start` (no mcpServers configured) can still edit, commit and open a PR.
      // memory (#118) is mounted on the manifest Worker so it can record durable repo facts.
      const tools = applyHooks(
        resolveWorkerTools(
          mcp.toolsForRole('worker'),
          worktree.path,
          input.resolved.bashRules,
          fetchHtmlAvailable,
          buildExploreFor(input, worktree.path),
          memoryToolFor(state),
        ),
        input,
        worktree.path,
      );
      const memoryIndex = await memoryIndexFor(state);
      // Regular Worker: web_search only when explicitly enabled (webSearch: true).
      const providerOptions = webSearchProviderOptions(input.resolved.webSearch, false);
      const agent = createWorkerAgent({
        model: input.credentials.modelFor('worker'),
        tools,
        systemPrompt: reminderAgentSystemPrompt({
          style,
          roleGuidance: WORKER_SYSTEM_PREFIX,
          cwd: worktree.path,
          maxSteps: WORKER_MAX_STEPS,
          modelId: input.credentials.modelIdFor('worker'),
          memoryIndex,
        }),
        prepareStep: buildCompactionStep<WorkerTools>({
          compactor,
          modelId: input.credentials.modelIdFor('worker'),
        }),
        timeout: stepTimeout,
        ...(providerOptions !== undefined ? { providerOptions } : {}),
        ...(workerUsage ? { onUsage: workerUsage } : {}),
      });
      return runWorkerSubagent(agent, {
        group,
        ...(task ? { task } : {}),
        worktreePath: worktree.path,
        baseBranch,
        styleContents: style,
        // Live read (issue #123): the second group's manifest prompt carries the first group's digest.
        rollingContext: rollingCtx.current(),
        contextBlock: harnessContextBlock(style),
        ...(input.resolved.formatCommand ? { formatCommand: input.resolved.formatCommand } : {}),
        ...(input.resolved.verifyCommand ? { verifyCommand: input.resolved.verifyCommand } : {}),
      });
    },
    finalizeCommit: (group, delivery, worktreePath) =>
      orch.finalizeCommit(group, delivery, worktreePath),
    openPr: async (group, delivery, baseBranch) => {
      // The Worker's commits live on the group branch in a linked worktree (shared object
      // store). Push it to origin first — `gh pr create` won't open a PR for a branch that
      // isn't on the remote ("No commits between … / Head ref must be a branch").
      const head = group.branch ?? `aitm/${group.id}`;
      await runGit(['push', '-u', 'origin', head], { cwd: input.cwd });
      const pr = await orch.openPr(group, delivery, baseBranch);
      // Accumulate this group's deterministic digest into the live rolling context and persist it
      // (issue #123), so the next group's Worker plans against it and a resumed run recovers it. The
      // accumulator serializes concurrent appends from a parallel group batch (no lost digest).
      await rollingCtx.append({ group, pr, delivery });
      return pr;
    },
    runReviewer: runReviewerThreads,
    // ci-failed stage → shared fix session: download failed logs + comments to the state dir, run
    // the coding-capability Worker pointed at them, rebase onto origin/<base>, force-with-lease push.
    runCiFix: async ({ group, pr, worktree, baseBranch }) => {
      const priorHandle = ciFixHandles.get(group.id);
      const ciFixProviderOptions = webSearchProviderOptions(input.resolved.webSearch, true);
      // The CI-fix Worker runs on the coding tier, so its fallback model id is the coding id.
      const ciFixUsage = roleUsageSink(
        input.usage,
        'worker',
        input.credentials.modelIdForCapability('coding'),
      );
      const ciFixMemoryIndex = await memoryIndexFor(state);
      const result = await runFixSession({
        github: input.github,
        prContext: new PrContextStore(resolvePath(input.cwd, '.ai-task-master')),
        subagents: {
          credentials: input.credentials,
          workerTools: applyHooks(
            resolveWorkerTools(
              mcp.toolsForRole('worker'),
              worktree.path,
              input.resolved.bashRules,
              fetchHtmlAvailable,
              buildExploreFor(input, worktree.path),
              memoryToolFor(state),
            ),
            input,
            worktree.path,
          ),
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
          ...(ciFixProviderOptions !== undefined ? { providerOptions: ciFixProviderOptions } : {}),
          // CI-fix Worker usage recorded under `worker`; it runs on the coding-tier model (#114).
          ...(ciFixUsage ? { onUsage: ciFixUsage } : {}),
          ...(input.resolved.formatCommand ? { formatCommand: input.resolved.formatCommand } : {}),
          ...(input.resolved.verifyCommand ? { verifyCommand: input.resolved.verifyCommand } : {}),
        },
        group,
        pr,
        baseBranch,
        worktreePath: worktree.path,
        allowForcePush: input.resolved.allowForcePush,
        ...(priorHandle ? { priorHandle } : {}),
      });
      if (result.kind === 'fixed') {
        // Retain this pass's conversation so the next fix pass for the group continues it (#107).
        ciFixHandles.set(group.id, result.handle);
        return { kind: 'ok' };
      }
      return { kind: 'blocked', reason: result.reason };
    },
    // addressing-reviews stage → run the Reviewer, then push its commits so the PR updates. The
    // Reviewer commits code fixes locally (worker pattern); a plain push suffices (additive commits,
    // no history rewrite). Replied/wontfix-only rounds make no commit, so there's nothing to push.
    addressReviews: async ({ pr, threads, worktree }) => {
      const result = await runReviewerThreads({ pr, threads, worktree });
      if (result.kind !== 'ok') {
        return {
          kind: 'blocked',
          reason: result.kind === 'blocked' ? result.reason : result.error,
        };
      }
      if (result.resolutions.some((r) => r.kind === 'fixed')) {
        await runGit(['push'], { cwd: worktree.path });
      }
      return { kind: 'ok' };
    },
  };
}

// MCP exposes a dynamically-typed ToolSet. The subagents need a statically-shaped tool record.
// Rather than fail closed when a server only exports the legacy readFile/writeFile/bash, we
// partial-fill: prefer the MCP tool for each name, falling back to the local worktree-scoped
// tool for any the server omits. The shape is asserted once at this boundary.
// The bash deny/allow rules govern the LOCAL compat bash tools only (issue #113): an MCP-supplied
// `bash` wins the partial-fill and sits outside this boundary — a documented limitation, not solved
// here. Harness-side git (runGit/assertGitAllowed, and the CI-fix rebase's own allowForcePush gate)
// never passes through the bash tool and is unaffected.
// The MCP ToolSet is now namespaced `mcp__<server>__<tool>` (issue #115), so partial-fill can no
// longer look up a bare canonical name. Prefer the first MCP tool whose namespaced key resolves to
// `canonical`, in server/config order (Object insertion order), else undefined → fall back local.
// Exported for the partial-fill regression test.
export function mcpTool(set: ToolSet, canonical: string): ToolSet[string] | undefined {
  for (const [key, entry] of Object.entries(set)) {
    if (mcpBaseName(key) === canonical) return entry;
  }
  return undefined;
}

// `mcp__<server>__<tool>` → `<tool>` (server has no `__`; a tool name may). Non-namespaced → undefined.
function mcpBaseName(key: string): string | undefined {
  const parts = key.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') return undefined;
  return parts.slice(2).join('__');
}

export function resolveWorkerTools(
  set: ToolSet,
  cwd: string,
  rules?: readonly CommandRule[],
  fetchHtmlAvailable = false,
  explore?: Tool<AgentToolInput, string>,
  memory?: Tool<MemoryToolInput, string>,
): WithExplore<WorkerTools> & WithMemory<WorkerTools> {
  const local = localEditTools(cwd, rules, fetchHtmlAvailable);
  // fetchHtml is optional: keep the key only when MCP supplies one or the local binary is available.
  const fetchHtml = mcpTool(set, 'fetchHtml') ?? local.fetchHtml;
  return {
    readFile: mcpTool(set, 'readFile') ?? local.readFile,
    writeFile: mcpTool(set, 'writeFile') ?? local.writeFile,
    editFile: mcpTool(set, 'editFile') ?? local.editFile,
    multiEdit: mcpTool(set, 'multiEdit') ?? local.multiEdit,
    grep: mcpTool(set, 'grep') ?? local.grep,
    glob: mcpTool(set, 'glob') ?? local.glob,
    bash: mcpTool(set, 'bash') ?? local.bash,
    multiBash: mcpTool(set, 'multiBash') ?? local.multiBash,
    webFetch: mcpTool(set, 'webFetch') ?? local.webFetch,
    datetime: mcpTool(set, 'datetime') ?? local.datetime,
    ...(fetchHtml ? { fetchHtml } : {}),
    // explore (#126) + memory (#118) are never MCP-filled — adapter-local glue, present only when
    // the caller wired them.
    ...(explore ? { explore } : {}),
    ...(memory ? { memory } : {}),
  } as WithExplore<WorkerTools> & WithMemory<WorkerTools>;
}

function resolveReviewerTools(
  set: ToolSet,
  cwd: string,
  github: Tool<GithubToolInput, GithubToolOutput>,
  rules?: readonly CommandRule[],
  fetchHtmlAvailable = false,
): ReviewerTools {
  return { ...resolveWorkerTools(set, cwd, rules, fetchHtmlAvailable), github };
}

// The Planner gets only the read-only subset, partial-filled the same way. This is also the fix
// for the latent no-MCP bug: previously the Planner was handed the raw MCP ToolSet with no local
// fallback, so a bare `aitm start` left it with zero tools despite its prompt promising
// readFile/grep/glob.
export function resolvePlannerTools(
  set: ToolSet,
  cwd: string,
  fetchHtmlAvailable = false,
  explore?: Tool<AgentToolInput, string>,
): WithExplore<PlannerTools> {
  const local = localReadTools(cwd, fetchHtmlAvailable);
  const fetchHtml = mcpTool(set, 'fetchHtml') ?? local.fetchHtml;
  return {
    readFile: mcpTool(set, 'readFile') ?? local.readFile,
    grep: mcpTool(set, 'grep') ?? local.grep,
    glob: mcpTool(set, 'glob') ?? local.glob,
    webFetch: mcpTool(set, 'webFetch') ?? local.webFetch,
    datetime: mcpTool(set, 'datetime') ?? local.datetime,
    ...(fetchHtml ? { fetchHtml } : {}),
    // explore (#126) is never MCP-filled — adapter-local glue, present only when the caller wired it.
    ...(explore ? { explore } : {}),
  } as WithExplore<PlannerTools>;
}

// The Reviewer's `github` tool is local glue over GitHubClient — not an MCP tool — so the
// adapter constructs it here rather than sourcing it from a server.
type ThreadGithub = Pick<GitHubClient, 'replyToThread' | 'resolveThread'>;

// Flat object, not a discriminatedUnion → no `oneOf` in the tool params (rejected by some
// OpenRouter-routed providers). `body` applies to replyToThread only.
const githubToolInputSchema = z.object({
  action: z.enum(['replyToThread', 'resolveThread']),
  threadId: z.string().min(1),
  body: z.string().optional(),
});

export function githubThreadTool(github: ThreadGithub): Tool<GithubToolInput, GithubToolOutput> {
  return tool<GithubToolInput, GithubToolOutput>({
    description: 'Reply to or resolve a PR review thread.',
    inputSchema: githubToolInputSchema,
    execute: async (input): Promise<GithubToolOutput> => {
      if (input.action === 'replyToThread') {
        await github.replyToThread(input.threadId, input.body ?? '');
        return { ok: true };
      }
      await github.resolveThread(input.threadId);
      return { ok: true };
    },
  });
}

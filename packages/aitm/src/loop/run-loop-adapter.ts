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

import { existsSync } from 'node:fs';
import { relative, resolve as resolvePath } from 'node:path';
import {
  type AgentToolInput,
  type BackgroundProcessTools,
  backgroundProcessTools,
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
  type ProcessManager,
  type ReminderProvider,
  type RetryInfo,
  readFileTool,
  SUBMIT_TOOL_NAME,
  type SubagentHandle,
  SYSTEM_REMINDER_CONTRACT,
  type ToolHooks,
  withHooks,
  withReminders,
  wrapReminder,
  writeFileTool,
} from '@developerz.ai/ai-claude-compat';
import { type ModelMessage, type Tool, type ToolLoopAgentSettings, type ToolSet, tool } from 'ai';
import { z } from 'zod';
// Type-only import — no runtime cycle with commands.ts, which imports this module's value.
import type { RunLoopInput } from '../cli/commands.ts';
import { buildCompactionStep } from '../compaction/compaction-step.ts';
import { Compactor } from '../compaction/compactor.ts';
import type { WebSearchConfig } from '../config/schema.ts';
import type { GitHubClient } from '../github/github-client.ts';
import { McpClientManager, type ToolSurface } from '../mcp/mcp-client.ts';
import { guardDeferred, TOOL_SEARCH_TOOL_NAME, toolSearch } from '../mcp/tool-search.ts';
import {
  createHeartbeatSink,
  type HeartbeatSink,
  startHeartbeat,
} from '../observability/heartbeat.ts';
import { makeStepCounter, type StepCounterFn } from '../observability/run-step.ts';
import {
  agentLabel,
  agentStepProgress,
  composeStepFinish,
  createLiveStreamRenderer,
  defaultProgressSink,
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
import { DEFAULT_MAX_STEPS, Orchestrator } from '../orchestrator/orchestrator.ts';
import { withAcceptanceCheck } from '../plan/acceptance.ts';
import { PlanGraph } from '../plan/plan-graph.ts';
import type { PlanMarkdownGroup } from '../plan/plan-markdown.ts';
import type { Plan } from '../plan/schema.ts';
import { PrContextStore } from '../state/pr-context-store.ts';
import { appendGroupDigest, type GroupDigestEntry } from '../state/rolling-context.ts';
import type { GroupStage, PrGroup, RunState } from '../state/schema.ts';
import type {
  RunEndOutcome,
  TranscriptRecorder,
  TranscriptStore,
  TranscriptTarget,
} from '../state/transcript-store.ts';
import { buildExploreTool } from '../subagents/explore.ts';
import type { OnUsage } from '../subagents/factory.ts';
import { buildMemoryTool, type MemoryToolInput } from '../subagents/memory-tool.ts';
import {
  createPlannerAgent,
  PLANNER_SYSTEM_PREFIX,
  type PlannerResult,
  type PlannerTools,
  runPlanner,
} from '../subagents/planner.ts';
import {
  createScoutRunner,
  SCOUT_LENSES,
  SCOUT_SYSTEM_PREFIX,
  shouldSurveyInParallel,
  surveyRepoInParallel,
  synthesizeSurveyBrief,
} from '../subagents/planner-scouts.ts';
import {
  createReviewerAgent,
  type GithubToolInput,
  type GithubToolOutput,
  REVIEWER_SYSTEM_PREFIX,
  type ReviewerTools,
  runReviewer as runReviewerSubagent,
} from '../subagents/reviewer.ts';
import { buildRolePrompt, type RolePromptInput } from '../subagents/role-prompt.ts';
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
import { datetimeTool } from '../tools/datetime.ts';
import { type FetchHtmlInput, fetchHtmlTool, isFetchHtmlAvailable } from '../tools/fetch-html.ts';
import { type WebFetchOutput, webFetchTool } from '../tools/web-fetch.ts';
import { webSearchTool } from '../tools/web-search.ts';
import {
  dedupeBranchNames,
  sanitizeBranchComponent,
  slugifyTitle,
} from '../workspace/branch-name.ts';
import { commitsAheadOfBase, runGit } from '../workspace/git-exec.ts';
import { InPlaceCheckout } from '../workspace/in-place-checkout.ts';
import { runFixSession } from './ci-fix.ts';
import { buildConflictResolver } from './conflict-resolution.ts';
import { makeProgressTee } from './progress-file.ts';
import { hasInterruptedGroup, normalizeResumeStatus } from './resume-normalize.ts';
import { runSelfReviewSession } from './self-review.ts';
import {
  type ReviewerInvocation,
  WorkLoop,
  type WorkLoopGithub,
  type WorkLoopGraph,
  type WorkLoopOrchestrator,
  type WorkLoopResult,
  type WorkLoopState,
} from './work-loop.ts';

// Checkout-scoped Claude-Code-style tools the Worker/Reviewer fall back to when no MCP server
// supplies them. aitm is MCP-first, but a bare `aitm start` (no `mcpServers` configured) must
// still be able to read, search, edit, commit and open a PR — so it uses the compat lib's
// tools, scoped to the active checkout.
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

// `bashOutput`/`killBash` (issue #103 background bash) are runtime-only extras for the same #112
// reason — static optional tool fields would inject `undefined` into the TypedToolCall union. They
// page and stop the background processes `bash({ run_in_background: true })` starts, mounted only when
// the run wired a ProcessManager.
type WithBackground<T> = T & {
  bashOutput?: BackgroundProcessTools['bashOutput'];
  killBash?: BackgroundProcessTools['killBash'];
};

// The run-scoped background-process handle threaded into the tool resolvers: the manager (routed into
// bashInit so `run_in_background` actually backgrounds) plus the two tools mounted for polling/stopping.
// One per run; runLoopAdapter kills leftovers at run end.
type BackgroundTools = Pick<BackgroundProcessTools, 'manager' | 'bashOutput' | 'killBash'>;

// The checkout-confined read-only trio the explore child surveys with — picked from localReadTools
// so it inherits the same resolveInside confinement, minus the web/datetime tools (the child's
// allowlist is readFile/grep/glob only). Rooted at the invoking agent's cwd/checkout.
export function exploreReadTools(cwd: string): ToolSet {
  const read = localReadTools(cwd);
  return { readFile: read.readFile, grep: read.grep, glob: read.glob };
}

// The explore tool for an agent rooted at `cwd`: a fast-tier child surveying the checkout-confined
// read trio (issue #126). Built per call site (Planner at the repo root, Worker at its group
// checkout) so the child never escapes the invoking agent's cwd.
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

// Resume messages for an interrupted (group, stage) transcript (issue #108) — looked up BEFORE a new
// recorder is begun for this run, so it can never self-resume from its own fresh (empty) file. Null
// when there is no store or nothing resumable. Reconstruction failures already return null in-store,
// so resume never blocks the run.
async function resumeMessagesFor(
  store: TranscriptStore | undefined,
  group: string,
  stage: GroupStage,
): Promise<ModelMessage[] | null> {
  if (!store) return null;
  const found = await store.findResumable(group, stage);
  if (!found) return null;
  if (found.recordingFailed) {
    process.stderr.write(
      `warning: resuming ${group}/${stage} from a transcript whose recorder had persistent write failures — resume context may be incomplete\n`,
    );
  }
  return found.messages;
}

// Map a subagent result kind to the transcript run-end outcome (issue #108).
function runEndOutcome(kind: string): RunEndOutcome {
  return kind === 'ok' ? 'submitted' : kind === 'error' ? 'error' : 'no-submission';
}

// Reduce a caught value to display text the way every catch site in this file already did
// (`err instanceof Error ? err.message : String(err)`), but without silently dropping the
// original value: wrapping a non-Error in a real Error keeps it reachable as `.cause` instead of
// discarding it once `String(err)` runs. A caught Error is returned as-is — same object, same
// `.message`, whatever `.cause` it already carried. Exported for the cause-preservation unit test.
export function describeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err), { cause: err });
}

// The console line for one LLM-call retry (slice 01b): RetryInfo.reason is always non-empty (compat's
// describeRetryReason), so this can never render an empty `Rate limited:` line. Exported for the unit
// test that pins the exact wording.
export function retryProgressMessage(info: RetryInfo): string {
  const seconds = Math.max(0, Math.round(info.delayMs / 1000));
  return `Rate limited (${info.reason}), retrying in ${seconds}s (${info.attempt}/${info.maxAttempts})`;
}

// Build an onRetry callback that reports a retry through harnessProgress under the given RunStep tag,
// via the SAME HeartbeatSink the caller's onStepFinish writes through — so a retry line counts as
// progress too and pushes back the heartbeat's next tick instead of racing it.
function onRetryProgress(
  step: RunStep | undefined,
  sink: HeartbeatSink,
): (info: RetryInfo) => void {
  return (info) => harnessProgress(retryProgressMessage(info), step, sink);
}

// Begin a transcript recorder, best-effort (issue #108 CR): a mkdir/readdir failure in begin() falls
// back to null instead of aborting the run — transcripts are optional observability, and the recorder
// itself already swallows write failures. Null store → null (no recording).
async function beginTranscript(
  store: TranscriptStore | undefined,
  target: TranscriptTarget,
): Promise<TranscriptRecorder | null> {
  if (!store) return null;
  try {
    return await store.begin(target);
  } catch (err) {
    process.stderr.write(`warning: transcript begin failed: ${describeError(err).message}\n`);
    return null;
  }
}

// An `onStepFinish` handler that records only the per-step message delta (issue #175). `ai@6` hands
// the callback the CUMULATIVE response-message list each step (per-step lengths [2, 4, 6] on a live
// run), not a delta — recording it verbatim grew transcript files O(N²) and made resume replay a
// duplicated conversation. Tracking the count already recorded and slicing keeps each record a true
// delta. One handler per recorder (fresh closure state); exported for tests.
export function recordStepDeltas(
  recorder: TranscriptRecorder,
): (event: {
  response: { messages: readonly ModelMessage[] };
  usage?: Parameters<TranscriptRecorder['step']>[1];
}) => void {
  let recorded = 0;
  return (event) => {
    const delta = event.response.messages.slice(recorded);
    recorded = event.response.messages.length;
    if (delta.length > 0) void recorder.step(delta, event.usage);
  };
}

// The SDK step event a role's `onStepFinish` receives — spelled once so the composeStepFinish call
// sites (recorder + progress stream share one slot) don't restate the settings-indexed type.
type StepEvent<TOOLS extends ToolSet> = Parameters<
  NonNullable<ToolLoopAgentSettings<never, TOOLS>['onStepFinish']>
>[0];

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
): WithFetchHtml<Pick<WorkerTools, 'webFetch' | 'webSearch' | 'datetime'>> {
  return {
    webFetch: webFetchTool(),
    webSearch: webSearchTool(),
    datetime: datetimeTool(),
    ...(fetchHtmlAvailable ? { fetchHtml: fetchHtmlTool() } : {}),
  };
}

export function localEditTools(
  cwd: string,
  rules?: readonly CommandRule[],
  fetchHtmlAvailable = false,
  processManager?: ProcessManager,
): WithFetchHtml<WorkerTools> {
  // One FileStateTracker per tool set (per subagent invocation) so read-before-edit enforcement is
  // scoped to a single run — the four file tools share it (issue #104).
  const fileState = new FileStateTracker();
  const staleReminders = makeStaleReminderProvider(fileState, cwd);
  // Deny/allow governance on the model-facing shell (issue #113). Omitted → no governance. A
  // ProcessManager (when the run wired one) routes `bash({ run_in_background: true })` to a spawned,
  // pollable process instead of degrading to the foreground (issue #103).
  const bashInit = {
    cwd,
    ...(rules ? { rules: [...rules] } : {}),
    ...(processManager ? { processManager } : {}),
  };
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

// The distiller bounds its digest to ~600 words (coding-style.ts INTRO), but the raw fallback — the
// target repo's verbatim CLAUDE.md/AGENTS.md, used when no digest was produced — is unbounded and
// would bloat every planner/worker/reviewer/self-review/CI-fix prompt (paid per subagent call). Cap
// it to a char budget matching that ceiling; keep the head, where house-style rules lead.
export const RAW_STYLE_MAX_CHARS = 4000;
const STYLE_TRUNCATION_MARKER = '\n\n[style truncated]';

// The style string injected into subagent prompts: the distilled digest when present (already
// bounded), else the raw style file capped to RAW_STYLE_MAX_CHARS. Single-sourced so the Planner and
// the Orchestrator bridge resolve style identically. Exported for the raw-fallback cap unit test.
export function resolveStyleContents(
  input: Pick<RunLoopInput, 'styleDigest' | 'agentConfig'>,
): string {
  return input.styleDigest ?? capRawStyle(input.agentConfig.contents);
}

function capRawStyle(contents: string): string {
  if (contents.length <= RAW_STYLE_MAX_CHARS) return contents;
  const budget = RAW_STYLE_MAX_CHARS - STYLE_TRUNCATION_MARKER.length;
  return contents.slice(0, budget) + STYLE_TRUNCATION_MARKER;
}

// The BYTE-STABLE leading context block prepended to every subagent's first user message: today's
// date, framed as advisory <system-reminder> context (issue #106). It carries no per-step content, so
// the leading prompt prefix is identical across every call in a conversation (and across a run's calls
// within a day) — the provider's prompt cache holds instead of being invalidated by a moving prefix
// (slice 04 §4). The date stays day-granular for the same reason (stable within a day).
//
// Two things stay OUT of this block on purpose:
//   - the run's Step N/M position — a per-call mutation that, sitting right after the cached prefix,
//     would bust the cache every step. It rides a TRAILING reminder (runProgressReminder) appended to
//     the END of the first message instead, where it can never reach the prefix.
//   - the target-repo style digest — already single-sourced in the subagent's system prompt
//     (buildRolePrompt's `style` slot, via reminderAgentSystemPrompt), a cacheable block built once per
//     call. Repeating it here paid for the same tokens twice on every step.
export function harnessContextBlock(): string {
  return contextReminder([{ label: 'currentDate', body: new Date().toISOString().slice(0, 10) }]);
}

// The run's phase + N/M position as a standalone TRAILING `<system-reminder>`, appended to the END of a
// subagent's first user message (slice 04 §4) so the model still knows where it is in the run without
// the position sitting in — and re-invalidating every step — the cacheable prompt prefix. '' when the
// step reports no position (a bare `{}`), so appendReminderBlock leaves the prompt untouched.
export function runProgressReminder(step: RunStep): string {
  const line = runStepContextLine(step);
  return line ? wrapReminder(`# runProgress\n${line}`) : '';
}

// Render a RunStep as a progress line: `Step N of M — <phase>` when the counter is known, `Phase:
// <phase>` when only the phase is (planning, before groups exist), '' when nothing is. Mirrors the
// observability tag (step-progress.formatStepTag) but in prose for the model, not the log.
export function runStepContextLine(step: RunStep): string {
  const hasCounter = step.index !== undefined && step.total !== undefined && step.total > 0;
  if (hasCounter) {
    const base = `Step ${step.index} of ${step.total}`;
    return step.phase ? `${base} — ${step.phase}` : base;
  }
  return step.phase ? `Phase: ${step.phase}` : '';
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
  // Append one lifecycle line to progress.md (plan.md's sibling) as the loop narrates group/task
  // transitions. Optional like writePlan; StateStore supplies it in production.
  appendProgress?(entry: string): Promise<void>;
  // The per-repo memory dir (issue #118). Optional: a port that omits it turns memory off entirely
  // (no index block, no memory tool). StateStore supplies it in production.
  memoryDir?(): string;
  // Per-subagent transcript store (issue #108). Optional: a port that omits it records nothing and
  // resumes nothing, so test stubs are untouched. StateStore supplies it in production.
  transcripts?(): TranscriptStore;
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
      `warning: failed to persist rolling context: ${describeError(err).message}\n`,
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
  // Resolve the N/M step counter for a group/task so every harness + agent line carries the run's
  // position (`group 2/5`, `task 3/38`). Built once per run in runLoopAdapter over the plan.
  stepCounter: StepCounterFn;
  // The run's single background-process handle (issue #103). Threaded into the worker/reviewer tool
  // resolvers so `bash({ run_in_background: true })` backgrounds and bashOutput/killBash are mounted.
  background: BackgroundTools;
  // Test seam (issue #189): override the Worker subagent runner so a test can deterministically
  // capture the worker input the bridge builds — chiefly that the resolved `editorConcurrency` cap
  // is threaded through. Omitted in production, where it defaults to the real runWorkerSubagent.
  workerRunner?: typeof runWorkerSubagent;
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
      });

  // One ProcessManager per run, bound to the repo root the single in-place checkout also uses, so a
  // `bash({ run_in_background: true })` (dev server, log tailer) actually backgrounds instead of
  // degrading to the foreground (issue #103). The adapter OWNS its lifecycle: killAll() on abort and
  // in the finally reaps every process a worker/reviewer left running.
  const background = seams.makeBackground?.(input) ?? backgroundProcessTools({ cwd: input.cwd });

  // Reap the MCP stdio children (Experimental_StdioMCPTransport spawns them, mcp-client.ts) AND any
  // leftover background processes the instant the run is aborted. A second Ctrl-C force-exits the
  // process (cli.ts installSignalHandlers) and Node's default signal termination skips the `finally`
  // below, so relying on it alone orphans them — reap eagerly on abort while we still can. Both are
  // idempotent (close() swaps out its server list before awaiting; killAll() only signals still-running
  // procs), so the finally repeats are harmless; the listener is detached in the finally so a
  // normally-completing run never leaks it.
  const reapOnAbort = () => {
    void mcp.close();
    background.manager.killAll();
  };
  input.signal?.addEventListener('abort', reapOnAbort, { once: true });

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

    // Step counter over the plan (claudetm parity): group N/M in group-mode, task N/M in prPerTask.
    // Group order + membership are fixed at plan time, so build it once and share it with the
    // orchestrator bridges (their harness + agent lines) and the WorkLoop (its transition lines).
    const stepCounter = makeStepCounter(groups, current.options.prPerTask ?? false);

    // ---- Live graph + state proxy ------------------------------------------
    // Validate the plan's structure ONCE, here at acceptance: duplicate ids, dangling deps, and cycles
    // are functions of group ids + dependsOn edges, which stay fixed for the whole run. The per-tick
    // ready()/isComplete() below only read live statuses, so they rebuild via PlanGraph.trusted() and
    // skip re-paying validate()'s DFS every tick (this gate also keeps that memoized DFS terminating).
    PlanGraph.validate(groups);
    // PlanGraph captures its groups at construction, so rebuild it per call against the
    // mirror that workLoopState keeps in sync after every persisted update.
    let liveGroups: readonly PrGroup[] = groups;
    const graph: WorkLoopGraph = {
      ready: () => PlanGraph.trusted(liveGroups).ready(),
      isComplete: () => PlanGraph.trusted(liveGroups).isComplete(),
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
    // Agents work in ONE checkout, scheduled as a team. InPlaceCheckout is single-slot, so
    // concurrency is a single slot: sequential groups, no two subagents mutating the tree at once.
    // (A later task reframes concurrency as a cap.)
    const effectiveConcurrency = 1;
    const checkout = seams.makeCheckout?.(input) ?? new InPlaceCheckout(input.cwd);
    const github = seams.makeGithub?.(input) ?? input.github;
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
      initialSessionCount: current.sessionCount,
      // Every harness narration line also lands in .ai-task-master/progress.md via the state port.
      progress: makeProgressTee(
        state.appendProgress ? { append: state.appendProgress.bind(state) } : {},
      ),
      stepCounter,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return await loop.run();
  } finally {
    input.signal?.removeEventListener('abort', reapOnAbort);
    background.manager.killAll();
    if (mcpConnected) {
      await mcp.close();
    }
  }
}

// ---- Plan ------------------------------------------------------------------

// Re-exported from workspace/branch-name.ts (its home now that WorkLoop also builds ref components).
// Kept on the adapter's surface so existing importers/tests are unaffected.
export { sanitizeBranchComponent };

// Resolve a group's branch name, honoring a caller-specified `--branch`.
//   - no branch requested        → `aitm/<group-id>-<title-slug>` (default)
//   - requested, single group    → the requested name verbatim (already validated by the CLI)
//   - requested, multiple groups → `<requested>/<group-id>-<title-slug>` so the groups' branches
//     (and the PRs they open) don't collide on one branch name.
// The title slug is what makes a branch list readable — `aitm/g1` says nothing next to
// `aitm/g1-add-todo-crud`, and on a repo where two people run aitm it is the difference between two
// runs sharing a branch name and not. Dropped when the title yields no usable characters.
// The group-id segment is always sanitized so the composed ref is valid regardless of what the
// Planner emitted.
export function branchFor(
  groupId: string,
  requested: string | undefined,
  totalGroups: number,
  title?: string,
): string {
  const safeId = sanitizeBranchComponent(groupId);
  const slug = title ? slugifyTitle(title) : '';
  // A title that just restates the id (`g1` / "G1") would give `aitm/g1-g1` — keep the bare id.
  const redundant = slug === '' || slug === safeId.toLowerCase();
  const segment = redundant ? safeId : `${safeId}-${slug}`;
  if (requested === undefined) return `aitm/${segment}`;
  return totalGroups <= 1 ? requested : `${requested}/${segment}`;
}

// Plan → the persisted PrGroups the loop drives. `takenBranches` is the set of branch names already
// published on the remote (see remoteBranchNames): every name aitm composes itself is resolved
// against it — and against this run's own groups — so two people running aitm on one repo can't end
// up sharing a branch and force-pushing over each other. Branches are assigned HERE, once, at plan
// acceptance; a resumed run reuses what state.json already holds and never re-dedupes.
// An explicit single-group `--branch` is the operator's own name: honored verbatim, never suffixed.
export function planToPrGroups(
  plan: Plan,
  branch?: string,
  takenBranches: ReadonlySet<string> = new Set(),
): PrGroup[] {
  const total = plan.groups.length;
  const desired = plan.groups.map((g) => branchFor(g.id, branch, total, g.title));
  const verbatim = branch !== undefined && total <= 1;
  const branches = verbatim ? desired : dedupeBranchNames(desired, takenBranches);
  return plan.groups.map((g, groupIndex) => ({
    id: g.id,
    title: g.title,
    acceptance: g.acceptance,
    tasks: g.tasks.map((t, i) => ({
      id: `${g.id}-${i + 1}`,
      text: t.description,
      complexity: t.complexity,
      done: false,
    })),
    dependsOn: g.dependsOn,
    branch: branches[groupIndex] ?? branchFor(g.id, branch, total, g.title),
    pr: null,
    status: 'pending' as const,
    stage: 'pending' as const,
  }));
}

// Branch names already published on `origin`, read in ONE `ls-remote` for the whole run rather than
// a probe per group. Best-effort by design: no origin, no network, or not a git repo all yield an
// empty set, so branch dedupe degrades to the plain names — a naming courtesy must never fail a run.
export async function remoteBranchNames(cwd: string): Promise<Set<string>> {
  try {
    const result = await runGit(['ls-remote', '--heads', 'origin'], { cwd });
    return new Set(parseRemoteHeads(result.stdout));
  } catch {
    return new Set();
  }
}

// Count of git-tracked files — a cheap proxy for "how much codebase the Planner must survey", used to
// gate the parallel scout sweep (planner-scouts.ts). Tracked files exclude node_modules/dist by
// construction (gitignored), so no vendor filter is needed. A non-repo or a git failure returns 0,
// which reads as "small" and skips the sweep — the safe default, since scouts only ever ADD cost.
export async function countTrackedFiles(cwd: string): Promise<number> {
  try {
    const result = await runGit(['ls-files'], { cwd });
    return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

// `<sha>\trefs/heads/<branch>` lines → branch names, skipping blank lines and any non-heads ref git
// prints. Exported for unit testing — it is the half of remoteBranchNames that has no process in it.
export function parseRemoteHeads(stdout: string): string[] {
  const prefix = 'refs/heads/';
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const ref = line.split('\t')[1]?.trim();
    if (ref?.startsWith(prefix) && ref.length > prefix.length) names.push(ref.slice(prefix.length));
  }
  return names;
}

// Run the parallel scout survey before planning, returning the synthesized brief — or undefined when
// the repo is below the size floor (scouts would be pure added cost) or the sweep produced nothing.
// Best-effort throughout: a git or scout failure degrades to no brief, never blocks the planner.
async function surveyRepoForPlanner(params: {
  input: RunLoopInput;
  style: string;
  plannerModelId: string;
  plannerUsage?: OnUsage;
  mcp: McpClientManager;
  fetchHtmlAvailable: boolean;
}): Promise<string | undefined> {
  const { input, style, plannerModelId, plannerUsage, mcp, fetchHtmlAvailable } = params;
  const fileCount = await countTrackedFiles(input.cwd);
  if (!shouldSurveyInParallel(fileCount)) return undefined;
  harnessProgress(
    `survey: ${SCOUT_LENSES.length} scouts sweeping ${fileCount} tracked files in parallel`,
    { phase: 'planning' },
  );
  const runScout = createScoutRunner({
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
      roleGuidance: SCOUT_SYSTEM_PREFIX,
      cwd: input.cwd,
      modelId: plannerModelId,
    }),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(plannerUsage ? { onUsage: plannerUsage } : {}),
  });
  const ctx = {
    goal: input.goal,
    ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
  };
  const findings = await surveyRepoInParallel(SCOUT_LENSES, ctx, runScout).catch(() => []);
  harnessProgress(`survey: ${findings.length}/${SCOUT_LENSES.length} scouts reported`, {
    phase: 'planning',
  });
  const brief = synthesizeSurveyBrief(findings);
  return brief === '' ? undefined : brief;
}

async function defaultPlanGroups(
  input: RunLoopInput,
  mcp: McpClientManager,
  fetchHtmlAvailable: boolean,
): Promise<PlanGroupsOutcome> {
  const style = resolveStyleContents(input);
  const plannerUsage = roleUsageSink(
    input.usage,
    'planner',
    input.credentials.modelIdFor('planner'),
  );
  // Planner gets the memory index (issue #118) but no memory tool: its read tools are rooted at the
  // repo cwd, so it reads memory files directly and stays read-only.
  const memoryIndex = await memoryIndexFor(input.state);
  // Transcript (issue #108): the planner run is recorded (never resumed — it always cold-starts).
  const plannerRecorder = await beginTranscript(input.state.transcripts?.(), { planner: true });
  const plannerModelId = input.credentials.modelIdFor('planner');
  harnessProgress(`planning with ${plannerModelId}: ${input.goal}`, { phase: 'planning' });
  const plannerTag: RunStep = { phase: 'planning' };
  const plannerLabel = agentLabel({ model: shortModelName(plannerModelId), role: 'planner' });
  // Shared sink (issue #01b liveliness): the heartbeat needs to see every progress write this call
  // makes (steps + retries) to tell silence from activity, so it must be the SAME sink instance
  // agentStepProgress/onRetry write through — not each's own default.
  const plannerHeartbeatSink = createHeartbeatSink(defaultProgressSink());
  // Streaming (slice 07): when on, live text/tool lines print via onStream below, so the step-finish
  // renderer here is told to skip them (textAndTools: false) — it still renders reasoning, which has
  // no live equivalent.
  const streaming = input.resolved.streaming;
  const plannerStep = composeStepFinish<StepEvent<PlannerTools>>(
    plannerRecorder ? recordStepDeltas(plannerRecorder) : undefined,
    agentStepProgress(plannerLabel, plannerTag, plannerHeartbeatSink, { textAndTools: !streaming }),
  );
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
      modelId: input.credentials.modelIdFor('planner'),
      memoryIndex,
    }),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(plannerUsage ? { onUsage: plannerUsage } : {}),
    ...(plannerStep ? { onStepFinish: plannerStep } : {}),
    onRetry: onRetryProgress(plannerTag, plannerHeartbeatSink),
    ...(streaming
      ? { onStream: createLiveStreamRenderer(plannerLabel, plannerTag, plannerHeartbeatSink) }
      : {}),
  });
  // Parallel pre-planning survey (planner-scouts.ts): on a big enough repo, a pool of read-only
  // scouts sweeps distinct lenses concurrently and hands the Planner a map, so its own steps go to
  // structure instead of discovery. Gated on tracked-file count — below the floor the sequential
  // survey is already fast and scouts would be pure added cost, so this returns undefined and the
  // Planner prompt is byte-identical. Best-effort: a failed sweep degrades to no brief, never blocks.
  const surveyBrief = await surveyRepoForPlanner({
    input,
    style,
    plannerModelId,
    ...(plannerUsage ? { plannerUsage } : {}),
    mcp,
    fetchHtmlAvailable,
  });

  const stopPlannerHeartbeat = startHeartbeat(plannerLabel, plannerHeartbeatSink);
  let result: PlannerResult;
  try {
    result = await runPlanner(agent, {
      goal: input.goal,
      styleContents: style,
      maxPrs: input.resolved.maxPrs,
      contextBlock: harnessContextBlock(),
      // No group counter yet — the Planner is what produces the groups — so the trailing progress
      // reminder carries the phase only (`Phase: planning`).
      progressBlock: runProgressReminder({ phase: 'planning' }),
      ...(input.criteria !== undefined ? { criteria: input.criteria } : {}),
      ...(surveyBrief !== undefined ? { surveyBrief } : {}),
    });
  } finally {
    stopPlannerHeartbeat();
  }
  await plannerRecorder?.end(runEndOutcome(result.kind));
  if (result.kind === 'ok') {
    // One remote read per run, here at first branch assignment — the only moment a branch name is
    // chosen. A resume never reaches this path, so a persisted branch is never renamed underneath a
    // half-finished PR.
    const groups = planToPrGroups(result.plan, input.branch, await remoteBranchNames(input.cwd));
    harnessProgress(
      `plan ready: ${groups.length} PR group(s) — ${groups.map((g) => g.id).join(', ')}`,
      { phase: 'planning' },
    );
    return { kind: 'ok', groups };
  }
  if (result.kind === 'blocked') return { kind: 'blocked', reason: result.reason };
  return { kind: 'error', error: result.error };
}

// ---- Orchestrator bridge ---------------------------------------------------

// web_search server-tool gating (issue #112) + optional domain filters (issue #195). The tri-state
// gate lives on a bare boolean or, for the object form, on its `enabled` field: undefined → CI-fix
// sessions only (highest lookup value, bounded cost); true → all Worker calls; false → never. When
// enabled, the object form's allowed/excluded domains ride the server-tool payload. Returns the
// providerOptions fragment (openrouter namespace) or undefined when web_search should not attach.
// Exported for tests.
export function webSearchProviderOptions(
  webSearch: WebSearchConfig | undefined,
  ciFix: boolean,
): ReturnType<typeof providerOptionsWithServerTools> | undefined {
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

export function defaultMakeOrchestrator(ctx: OrchestratorBridgeCtx): WorkLoopOrchestrator {
  const { input, mcp, rollingContext, fetchHtmlAvailable, state, stepCounter, background } = ctx;
  const workerRunner = ctx.workerRunner ?? runWorkerSubagent;
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
      const shipped = await discoverSpecialists(input.cwd);
      if (shipped.length > 0) return shipped;
      if (input.resolved.generateSpecialists === false) return shipped;
      // Bootstrap must never break (or even delay-fail) a run: a state port without read() (test
      // stubs), a stub credentials object, or a provider failure all degrade to the empty roster —
      // byte-identical to a repo with no agents before this feature.
      try {
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
        return shipped;
      }
    })());
  // Announce the discovered roster once, up front (mirrors claudetm's "Found N subagents"). For a
  // repo that ships agents this is a cheap dir read; for a generated team it also fronts the one
  // LLM call so the roster line still appears before the first group starts. Fire-and-forget —
  // failures degrade to an empty roster inside the promise, never delaying the run.
  void specialistRoster().then((roster) => {
    if (roster.length > 0) {
      harnessProgress(
        `found ${roster.length} specialist(s): ${roster.map((a) => a.name).join(', ')}`,
      );
    }
  });

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
    maxSteps: DEFAULT_MAX_STEPS,
    github: input.github,
    ...(input.resolved.prBodySections !== undefined
      ? { prBodySections: input.resolved.prBodySections }
      : {}),
    timeout: stepTimeout,
    ...(orchUsage ? { onUsage: orchUsage } : {}),
    onProgress: (message) => harnessProgress(message),
  });

  // Build + run the Reviewer over a thread set in the given checkout. Wrapped by addressReviews
  // (which pushes the fixes), used by both the stage machine and the prPerTask autoMergeFlow. The
  // reviewer is recorded (issue #108) but never resumed — resume applies only to 'working'/'ci-failed'.
  // The per-thread conversations share one agent, so this records them into one transcript rather than one-per-thread.
  const runReviewerThreads = async ({ pr, threads, checkout }: ReviewerInvocation) => {
    const github = githubThreadTool(input.github);
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
    const reviewerTag: RunStep = { phase: 'reviewing', ...reviewerCounter };
    const reviewerLabel = agentLabel({
      model: shortModelName(reviewerModelId),
      role: 'reviewer',
      ctx: checkout.groupId,
    });
    const reviewerHeartbeatSink = createHeartbeatSink(defaultProgressSink());
    const reviewerStreaming = input.resolved.streaming;
    const reviewerStep = composeStepFinish<StepEvent<ReviewerTools>>(
      recorder ? recordStepDeltas(recorder) : undefined,
      agentStepProgress(reviewerLabel, reviewerTag, reviewerHeartbeatSink, {
        textAndTools: !reviewerStreaming,
      }),
    );
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
      ...(reviewerStep ? { onStepFinish: reviewerStep } : {}),
      onRetry: onRetryProgress(reviewerTag, reviewerHeartbeatSink),
      ...(reviewerStreaming
        ? { onStream: createLiveStreamRenderer(reviewerLabel, reviewerTag, reviewerHeartbeatSink) }
        : {}),
    });
    const stopReviewerHeartbeat = startHeartbeat(reviewerLabel, reviewerHeartbeatSink);
    let result: Awaited<ReturnType<typeof runReviewerSubagent>>;
    try {
      result = await runReviewerSubagent(agent, {
        pr,
        threads,
        checkoutPath: checkout.path,
        // The single checkout is on the PR head branch (the PR was opened from it); pin it so a
        // review fix commit can never land on the wrong branch (audit 02, DECISION 1).
        headBranch: checkout.branch,
        styleContents: style,
        contextBlock: harnessContextBlock(),
        progressBlock: runProgressReminder(reviewerTag),
      });
    } finally {
      stopReviewerHeartbeat();
    }
    await recorder?.end(runEndOutcome(result.kind));
    return result;
  };

  return {
    runWorker: async ({ group, task, checkout, baseBranch }) => {
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
            buildExploreFor(input, checkout.path),
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
      const providerOptions = webSearchProviderOptions(input.resolved.webSearch, false);
      const workerModelId = input.credentials.modelIdFor('worker');
      const workerModel = shortModelName(workerModelId);
      const workerStepTag: RunStep = { phase: 'working', ...stepCounter(group.id, task) };
      // Route this group/task to the target repo's best-matching domain specialist, if any. Its
      // guidance layers onto the Worker's base role prefix; no match → the base prefix, unchanged.
      const routed = selectSpecialistWithScore(
        await specialistRoster(),
        buildSpecialistSignal(group, task),
      );
      const specialist = routed?.agent ?? null;
      if (routed) {
        harnessProgress(
          `group ${group.id}: routing to '${routed.agent.name}' specialist (score ${routed.score})`,
          workerStepTag,
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
        workerStepTag,
      );
      // The stream label names the SUBAGENT: the routed specialist (backend/jobs/frontend…) when one
      // matched, else the bare 'worker' role. So `[k3 backend g1 3/38 working] …` on a routed task.
      const workerAgentLabel = agentLabel({
        model: workerModel,
        role: 'worker',
        ...(specialist ? { specialist: specialist.name } : {}),
        ctx: group.id,
      });
      const workerHeartbeatSink = createHeartbeatSink(defaultProgressSink());
      const workerStreaming = input.resolved.streaming;
      const workerStep = composeStepFinish<StepEvent<WorkerTools>>(
        recorder ? recordStepDeltas(recorder) : undefined,
        agentStepProgress(workerAgentLabel, workerStepTag, workerHeartbeatSink, {
          textAndTools: !workerStreaming,
        }),
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
        ...(workerStep ? { onStepFinish: workerStep } : {}),
        // Editor fanout runs on the worker model; per-step-field-only progress is parallel-safe.
        // Each leaf's `editorTag` (file/dir basename, issue #131) names the leaf in its own label.
        onEditorStepFinish: (editorTag) =>
          agentStepProgress(
            agentLabel({ model: workerModel, role: 'editor', ctx: group.id, file: editorTag }),
            workerStepTag,
          ),
        onRetry: onRetryProgress(workerStepTag, workerHeartbeatSink),
        ...(workerStreaming
          ? {
              onStream: createLiveStreamRenderer(
                workerAgentLabel,
                workerStepTag,
                workerHeartbeatSink,
              ),
            }
          : {}),
      });
      const stopWorkerHeartbeat = startHeartbeat(workerAgentLabel, workerHeartbeatSink);
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
          progressBlock: runProgressReminder(workerStepTag),
          ...(input.resolved.formatCommand ? { formatCommand: input.resolved.formatCommand } : {}),
          ...(input.resolved.verifyCommand ? { verifyCommand: input.resolved.verifyCommand } : {}),
          // Bound the editor fanout at the resolved cap (issue #189). Always a number (config default
          // 4), so passed unconditionally — with the default it equals EDITOR_CONCURRENCY_DEFAULT, so
          // behavior is unchanged until an operator sets `editorConcurrency`.
          editorConcurrency: input.resolved.editorConcurrency,
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
      await runGit(['push', '-u', 'origin', head], { cwd: input.cwd });
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
      const selfReviewProviderOptions = webSearchProviderOptions(input.resolved.webSearch, false);
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
      const selfReviewTag: RunStep = { phase: 'self-review', ...stepCounter(group.id) };
      harnessProgress(
        `group ${group.id}: self-reviewing the diff with ${selfReviewModelId} before opening the PR`,
        selfReviewTag,
      );
      const selfReviewLabel = agentLabel({
        model: selfReviewModel,
        role: 'self-review',
        ctx: group.id,
      });
      const selfReviewHeartbeatSink = createHeartbeatSink(defaultProgressSink());
      const selfReviewStreaming = input.resolved.streaming;
      const selfReviewStep = composeStepFinish<StepEvent<WorkerTools>>(
        agentStepProgress(selfReviewLabel, selfReviewTag, selfReviewHeartbeatSink, {
          textAndTools: !selfReviewStreaming,
        }),
      );
      const stopSelfReviewHeartbeat = startHeartbeat(selfReviewLabel, selfReviewHeartbeatSink);
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
                buildExploreFor(input, checkout.path),
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
            progressBlock: runProgressReminder(selfReviewTag),
            ...(selfReviewMemoryIndex.length > 0 ? { memoryIndex: selfReviewMemoryIndex } : {}),
            ...(rollingCtx.current().trim() !== '' ? { rollingContext: rollingCtx.current() } : {}),
            ...(selfReviewProviderOptions !== undefined
              ? { providerOptions: selfReviewProviderOptions }
              : {}),
            ...(selfReviewUsage ? { onUsage: selfReviewUsage } : {}),
            ...(input.resolved.formatCommand
              ? { formatCommand: input.resolved.formatCommand }
              : {}),
            ...(selfReviewStep ? { onStepFinish: selfReviewStep } : {}),
            onEditorStepFinish: (editorTag) =>
              agentStepProgress(
                agentLabel({
                  model: selfReviewModel,
                  role: 'editor',
                  ctx: group.id,
                  file: editorTag,
                }),
                selfReviewTag,
              ),
            onRetry: onRetryProgress(selfReviewTag, selfReviewHeartbeatSink),
            ...(selfReviewStreaming
              ? {
                  onStream: createLiveStreamRenderer(
                    selfReviewLabel,
                    selfReviewTag,
                    selfReviewHeartbeatSink,
                  ),
                }
              : {}),
          },
          group,
          baseBranch,
          checkoutPath: checkout.path,
          ...(verifyCommand ? { verifyCommand } : {}),
        });
      } finally {
        stopSelfReviewHeartbeat();
      }
    },
    // ci-failed stage → shared fix session: download failed logs + comments to the state dir, run
    // the coding-capability Worker pointed at them, rebase onto origin/<base>, force-with-lease push.
    runCiFix: async ({ group, pr, checkout, baseBranch }) => {
      const priorHandle = ciFixHandles.get(group.id);
      const ciFixProviderOptions = webSearchProviderOptions(input.resolved.webSearch, true);
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
      const ciFixTag: RunStep = { phase: 'ci-fix', ...stepCounter(group.id) };
      harnessProgress(
        `group ${group.id}: CI failed on PR #${pr} — running fix session with ${ciFixModelId}`,
        ciFixTag,
      );
      const ciFixLabel = agentLabel({ model: ciFixModel, role: 'ci-fix', ctx: group.id });
      const ciFixHeartbeatSink = createHeartbeatSink(defaultProgressSink());
      const ciFixStreaming = input.resolved.streaming;
      const ciFixStep = composeStepFinish<StepEvent<WorkerTools>>(
        ciRecorder ? recordStepDeltas(ciRecorder) : undefined,
        agentStepProgress(ciFixLabel, ciFixTag, ciFixHeartbeatSink, {
          textAndTools: !ciFixStreaming,
        }),
      );
      const ciFixWorkerTools = applyHooks(
        resolveWorkerTools(
          mcp.toolsForRole('worker'),
          checkout.path,
          input.resolved.bashRules,
          fetchHtmlAvailable,
          buildExploreFor(input, checkout.path),
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
              ciFixTag,
            ),
          })
        : undefined;
      const stopCiFixHeartbeat = startHeartbeat(ciFixLabel, ciFixHeartbeatSink);
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
            ...(ciFixStep ? { onStepFinish: ciFixStep } : {}),
            onEditorStepFinish: (editorTag) =>
              agentStepProgress(
                agentLabel({ model: ciFixModel, role: 'editor', ctx: group.id, file: editorTag }),
                ciFixTag,
              ),
            onRetry: onRetryProgress(ciFixTag, ciFixHeartbeatSink),
            ...(ciFixStreaming
              ? { onStream: createLiveStreamRenderer(ciFixLabel, ciFixTag, ciFixHeartbeatSink) }
              : {}),
            ...(ciResume ? { resumeMessages: ciResume } : {}),
            ...(ciFixResolveConflicts ? { resolveConflicts: ciFixResolveConflicts } : {}),
          },
          group,
          pr,
          baseBranch,
          checkoutPath: checkout.path,
          allowForcePush: input.resolved.allowForcePush,
          ...(priorHandle ? { priorHandle } : {}),
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
  };
}

// MCP exposes a dynamically-typed ToolSet. The subagents need a statically-shaped tool record.
// Rather than fail closed when a server only exports the legacy readFile/writeFile/bash, we
// partial-fill: prefer the MCP tool for each name, falling back to the local checkout-scoped
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

// Fixed-slot canonical names that resolveWorkerTools/resolvePlannerTools partial-fill. An MCP tool
// whose base name is one of these is consumed into that slot (never dropped), so it is not part of
// the "surplus" deferred loading operates on (issue #119).
const FIXED_SLOT_NAMES = new Set<string>([
  'readFile',
  'writeFile',
  'editFile',
  'multiEdit',
  'grep',
  'glob',
  'bash',
  'multiBash',
  'webFetch',
  'datetime',
  'fetchHtml',
]);

// The role's surplus MCP tools — everything beyond the fixed slots. Deferred loading operates on
// these; today they are dropped by the fixed-record resolvers (issue #119).
function surplusMcpTools(set: ToolSet): ToolSet {
  const out: ToolSet = {};
  for (const [key, entry] of Object.entries(set)) {
    if (!FIXED_SLOT_NAMES.has(mcpBaseName(key) ?? key)) out[key] = entry;
  }
  return out;
}

type PrepareStep<TOOLS extends ToolSet> = NonNullable<
  ToolLoopAgentSettings<never, TOOLS>['prepareStep']
>;

// Deferred-loading mount for a role (issue #119). Splits the surface's surplus into directly-mounted
// (full schema) vs. deferred (name-only + `tool_search` + guard). Below the threshold nothing is
// deferred: the direct surplus still mounts, but there is no tool_search, no index block, and
// `activated` is null so the caller keeps its plain compaction prepareStep — the surface is
// byte-identical to today for that role.
type DeferredMount = {
  extraTools: ToolSet;
  indexBlock: string;
  deferredNames: ReadonlySet<string>;
  activated: ReadonlySet<string> | null;
};

export function mountDeferredTools(surface: ToolSurface): DeferredMount {
  const directSurplus = surplusMcpTools(surface.direct);
  const deferredSurplus = surplusMcpTools(surface.deferred);
  const deferredKeys = Object.keys(deferredSurplus);
  if (deferredKeys.length === 0) {
    return {
      extraTools: directSurplus,
      indexBlock: '',
      deferredNames: new Set(),
      activated: null,
    };
  }
  const search = toolSearch(deferredSurplus);
  const guarded: ToolSet = {};
  for (const [name, entry] of Object.entries(deferredSurplus)) {
    guarded[name] = guardDeferred(name, entry, search.activated);
  }
  return {
    extraTools: { ...directSurplus, ...guarded, [TOOL_SEARCH_TOOL_NAME]: search.tool },
    indexBlock: search.indexBlock,
    deferredNames: new Set(deferredKeys),
    activated: search.activated,
  };
}

// The active-tool subset for a step: every mounted tool (plus `submit`) except deferred tools not
// yet activated. Grows as activations accumulate within one invocation.
export function activeToolNames(
  tools: ToolSet,
  deferredNames: ReadonlySet<string>,
  activated: ReadonlySet<string>,
): string[] {
  return [...Object.keys(tools), SUBMIT_TOOL_NAME].filter(
    (name) => !deferredNames.has(name) || activated.has(name),
  );
}

// Compose activeTools onto the #102 compaction prepareStep: one function returns `activeTools` every
// step and the compaction `messages` override when it triggers (issue #119 §"Activation plumbing").
// activeTools is recomputed per step so newly activated deferred tools become callable.
function withActiveTools<TOOLS extends ToolSet>(
  base: PrepareStep<TOOLS>,
  tools: ToolSet,
  deferredNames: ReadonlySet<string>,
  activated: ReadonlySet<string>,
): PrepareStep<TOOLS> {
  return async (options) => {
    const result = await base(options);
    return {
      ...(result ?? {}),
      activeTools: activeToolNames(tools, deferredNames, activated) as Array<keyof TOOLS>,
    };
  };
}

// Append the deferred-tool index block to a role's system prompt, or return it unchanged when the
// role has nothing deferred (issue #119).
function appendIndexBlock(prompt: string, indexBlock: string): string {
  return indexBlock ? `${prompt}\n\n${indexBlock}` : prompt;
}

export function resolveWorkerTools(
  set: ToolSet,
  cwd: string,
  rules?: readonly CommandRule[],
  fetchHtmlAvailable = false,
  explore?: Tool<AgentToolInput, string>,
  memory?: Tool<MemoryToolInput, string>,
  background?: BackgroundTools,
): WithExplore<WorkerTools> & WithMemory<WorkerTools> & WithBackground<WorkerTools> {
  const local = localEditTools(cwd, rules, fetchHtmlAvailable, background?.manager);
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
    // the caller wired them. bashOutput/killBash (#103) are the same: run-scoped background handles.
    ...(explore ? { explore } : {}),
    ...(memory ? { memory } : {}),
    ...(background ? { bashOutput: background.bashOutput, killBash: background.killBash } : {}),
  } as WithExplore<WorkerTools> & WithMemory<WorkerTools> & WithBackground<WorkerTools>;
}

function resolveReviewerTools(
  set: ToolSet,
  cwd: string,
  github: Tool<GithubToolInput, GithubToolOutput>,
  rules?: readonly CommandRule[],
  fetchHtmlAvailable = false,
  background?: BackgroundTools,
): ReviewerTools {
  return {
    ...resolveWorkerTools(set, cwd, rules, fetchHtmlAvailable, undefined, undefined, background),
    github,
  };
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

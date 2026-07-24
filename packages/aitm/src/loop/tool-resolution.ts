// Checkout-scoped Claude-Code-style tools the Worker/Reviewer fall back to when no MCP server
// supplies them, plus the MCP partial-fill / deferred-loading machinery that turns a dynamically
// typed MCP ToolSet into the statically shaped tool records the subagents need. aitm is MCP-first,
// but a bare `aitm start` (no `mcpServers` configured) must still be able to read, search, edit,
// commit and open a PR — so it uses the compat lib's tools, scoped to the active checkout.

import { relative } from 'node:path';
import {
  type AgentToolInput,
  type BackgroundProcessTools,
  bashTool,
  type CommandRule,
  editFileTool,
  FileStateTracker,
  globTool,
  grepTool,
  multiBashTool,
  multiEditTool,
  type ProcessManager,
  type ReminderProvider,
  readFileTool,
  SUBMIT_TOOL_NAME,
  type ToolHooks,
  withHooks,
  withReminders,
  writeFileTool,
} from '@developerz.ai/ai-claude-compat';
import type { Tool, ToolLoopAgentSettings, ToolSet } from 'ai';
import type { RunLoopInput } from '../composition/run-input.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import type { ToolSurface } from '../mcp/mcp-client.ts';
import { guardDeferred, TOOL_SEARCH_TOOL_NAME, toolSearch } from '../mcp/tool-search.ts';
import { buildExploreTool } from '../subagents/explore.ts';
import type { OnUsage } from '../subagents/factory.ts';
import type { MemoryToolInput } from '../subagents/memory-tool.ts';
import type { PlannerTools } from '../subagents/planner.ts';
import type { ReviewerTools } from '../subagents/reviewer.ts';
import type { WorkerTools } from '../subagents/worker.ts';
import { datetimeTool } from '../tools/datetime.ts';
import { type FetchHtmlInput, fetchHtmlTool } from '../tools/fetch-html.ts';
import type { GithubToolInput, GithubToolOutput } from '../tools/github-thread-tool.ts';
import { type WebFetchOutput, webFetchTool } from '../tools/web-fetch.ts';
import { webSearchTool } from '../tools/web-search.ts';

// A reminder provider that surfaces the tracker's stale set on a file tool's result (issue #106): a
// file changed on disk since the model read it yields one file-changed-externally note on the next
// successful file-tool result. Shared by localEditTools and localReadTools.
function makeStaleReminderProvider(fileState: FileStateTracker, cwd: string): ReminderProvider {
  return () => staleFileReminders(fileState, cwd);
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

// fetchHtml is a RUNTIME-ONLY extra on the core tool sets: an optional tool *field* on a ToolLoopAgent
// generic injects `undefined` into the SDK's TypedToolCall union (issue #112), so it never sits on
// WorkerTools/PlannerTools. The local builders return the core set plus this optional extra; the
// model still gets the tool at runtime, and resolvers cast back to the core type.
export type WithFetchHtml<T> = T & { fetchHtml?: Tool<FetchHtmlInput, WebFetchOutput> };

// `explore` (issue #126) is a runtime-only extra for the same reason as fetchHtml: an optional tool
// field on WorkerTools/PlannerTools would inject `undefined` into the ToolLoopAgent TypedToolCall
// union (#112). It sits here so the core tool types stay unchanged — every record built without it
// (take-over flow, orchestrator-as-tool, test stubs) compiles and behaves exactly as today.
export type WithExplore<T> = T & { explore?: Tool<AgentToolInput, string> };

// `memory` (issue #118) is a runtime-only extra for the same reason: it needs the StateStore memory
// dir (state context compat's local builders don't have), and a static optional field would trip the
// #112 TypedToolCall union. Present on the Worker set only when the state port hands out a memory dir.
export type WithMemory<T> = T & { memory?: Tool<MemoryToolInput, string> };

// `bashOutput`/`killBash` (issue #103 background bash) are runtime-only extras for the same #112
// reason — static optional tool fields would inject `undefined` into the TypedToolCall union. They
// page and stop the background processes `bash({ run_in_background: true })` starts, mounted only when
// the run wired a ProcessManager.
export type WithBackground<T> = T & {
  bashOutput?: BackgroundProcessTools['bashOutput'];
  killBash?: BackgroundProcessTools['killBash'];
};

// The run-scoped background-process handle threaded into the tool resolvers: the manager (routed into
// bashInit so `run_in_background` actually backgrounds) plus the two tools mounted for polling/stopping.
// One per run; runLoopAdapter kills leftovers at run end.
export type BackgroundTools = Pick<BackgroundProcessTools, 'manager' | 'bashOutput' | 'killBash'>;

// The checkout-confined read-only trio the explore child surveys with — picked from localReadTools
// so it inherits the same resolveInside confinement, minus the web/datetime tools (the child's
// allowlist is readFile/grep/glob only). Rooted at the invoking agent's cwd/checkout.
export function exploreReadTools(cwd: string): ToolSet {
  const read = localReadTools(cwd);
  return { readFile: read.readFile, grep: read.grep, glob: read.glob };
}

// The explore tool for an agent rooted at `cwd`: a fast-tier child surveying the checkout-confined
// read trio (issue #126). Built per call site (Planner at the repo root, Worker at its group
// checkout) so the child never escapes the invoking agent's cwd. Timeout and onUsage are threaded from
// the parent agent so the explore child is covered by per-step deadlines and cost ceilings.
export function buildExploreFor(
  input: RunLoopInput,
  cwd: string,
  onUsage?: OnUsage,
): Tool<AgentToolInput, string> {
  return buildExploreTool({
    model: input.credentials.modelForCapability('fast'),
    readTools: exploreReadTools(cwd),
    timeout: { stepMs: input.resolved.llmStepTimeoutMs },
    ...(onUsage !== undefined ? { onUsage } : {}),
  });
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

// Apply operator-configured PreToolUse/PostToolUse hooks over a resolved tool record (issue #121),
// after the MCP/local partial-fill so both MCP-supplied and local tools are covered. No hooks
// configured → the record is returned untouched. Takes just the resolved config (not the whole
// RunLoopInput) so the merge-pr adapter can reuse it over a RunMergeFlowInput too. Exported for tests.
export function applyHooks<T extends ToolSet>(
  tools: T,
  source: { resolved: ResolvedConfig },
  cwd: string,
): T {
  // The zod-inferred config type spells optional fields as `T | undefined`; withHooks reads them
  // with `?? []`, so the shapes are runtime-identical — the cast only reconciles exactOptional.
  const hooks = source.resolved.hooks as ToolHooks | undefined;
  return hooks ? withHooks(tools, hooks, { cwd }) : tools;
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
export type DeferredMount = {
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
export function withActiveTools<TOOLS extends ToolSet>(
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
export function appendIndexBlock(prompt: string, indexBlock: string): string {
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

export function resolveReviewerTools(
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

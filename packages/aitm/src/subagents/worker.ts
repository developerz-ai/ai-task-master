// docs/subagents.md (Worker row), docs/task-groups.md, docs/commands/start.md
// One PR group: produce file changes + commits on a dedicated branch. Does NOT open the PR
// and does NOT finalize the commit message — those belong to the Orchestrator (more reliable
// at composing global-context narration: PR title, body, squash commit message).
//
// Strategy for *really big PRs* (the explicit design goal) — two layers of parallelism:
//
//   Layer A (outer, across files): plan a file manifest via the `submit` tool that lists every
//   file to create/modify/delete (docs/vendor/ai-sdk/chunk-09.md §"Orchestrator-Worker"),
//   then Promise.all over per-file editor sub-subagents.
//
//   Layer B (inner, within one step): each editor enables `parallelToolCalls: true` (default
//   in the SDK — chunk-02.md §"parallelToolCalls") so the model can issue multiple readFile /
//   writeFile tool calls in a single step and the runtime executes them concurrently.
//
// SDK references:
//   chunk-09.md §"Orchestrator-Worker" (manifest + per-file workers)
//   chunk-09.md §"Subagents" §"Controlling What the Model Sees" (toModelOutput one-line summary)
//   chunk-04.md §"ToolLoopAgent" (agent class)
//   chunk-02.md §"Tool Calling" (parallelToolCalls)

import { basename } from 'node:path';
import type {
  BashInput,
  BashOutput,
  EditFileInput,
  EditFileOutput,
  GlobInput,
  GlobOutput,
  GrepInput,
  GrepOutput,
  MultiBashInput,
  MultiBashOutput,
  MultiEditInput,
  MultiEditOutput,
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
} from '@developerz.ai/ai-claude-compat';
import {
  callWithStepTimeout,
  continueSubagent,
  correctiveMessage,
  createSubagent,
  formatSubmitIssues,
  runPool,
  runSubagent,
  type SubagentHandle,
  type SubmittedOutput,
  submittedOutput,
  wrapReminder,
} from '@developerz.ai/ai-claude-compat';
import {
  generateText,
  stepCountIs,
  type Tool,
  type ToolLoopAgent,
  type ToolLoopAgentSettings,
  tool,
} from 'ai';
import { z } from 'zod';
import type { LoggerLike } from '../logger/logger.ts';
import { harnessProgress } from '../observability/step-progress.ts';
import type { PrGroup, Task } from '../state/schema.ts';
import type { DatetimeInput, DatetimeOutput } from '../tools/datetime.ts';
import type { WebFetchInput, WebFetchOutput } from '../tools/web-fetch.ts';
import type { WebSearchInput, WebSearchOutput } from '../tools/web-search.ts';
import {
  appendReminderBlock,
  type OnUsage,
  prependContextBlock,
  reportUsage,
  type SubagentInit,
} from './factory.ts';
import { EDITOR_SYSTEM_PREFIX } from './prompts/role-guidance.ts';
import { buildEditorRolePrompt } from './role-prompt.ts';

// The Claude-Code-style tool surface (from @developerz.ai/ai-claude-compat) the Worker drives:
// read/write whole files, edit by exact string replace (single + atomic batch), and search the
// repo with grep/glob. The Worker also invokes `bash` directly during the commit phase.
export type WorkerTools = {
  readFile: Tool<ReadFileInput, ReadFileOutput>;
  writeFile: Tool<WriteFileInput, WriteFileOutput>;
  editFile: Tool<EditFileInput, EditFileOutput>;
  multiEdit: Tool<MultiEditInput, MultiEditOutput>;
  grep: Tool<GrepInput, GrepOutput>;
  glob: Tool<GlobInput, GlobOutput>;
  bash: Tool<BashInput, BashOutput>;
  multiBash: Tool<MultiBashInput, MultiBashOutput>;
  // Web + time tools (issue #112). Always present (local fallback). The optional curl-impersonate
  // `fetchHtml` is NOT a field here: an optional tool property injects `undefined` into the SDK's
  // TypedToolCall union. It is mounted as a runtime extra by the adapter when its binary is available.
  webFetch: Tool<WebFetchInput, WebFetchOutput>;
  // Provider-agnostic web search (DuckDuckGo, no key) so the Worker can search on ANY model, not
  // only OpenRouter-routed ones. A local function tool, so it is a core field like webFetch.
  webSearch: Tool<WebSearchInput, WebSearchOutput>;
  datetime: Tool<DatetimeInput, DatetimeOutput>;
};

// File manifest — Phase 1 structured output. Each entry drives one editor in Phase 2.
export const FileManifestEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['create', 'modify', 'delete']),
  purpose: z.string().min(1),
});
export type FileManifestEntry = z.infer<typeof FileManifestEntrySchema>;

export const FileManifestSchema = z.object({
  files: z.array(FileManifestEntrySchema),
  draftCommitMessage: z.string().min(1),
  // Explicit declaration that the task requires no code changes (verificationonly, or the change
  // already exists). Only honored alongside an empty `files` list: it completes the task without a
  // commit instead of conflating a reasoned empty manifest with a weak-model failure.
  noChangesNeeded: z.string().min(1).optional(),
  // The Coordinator already wrote every listed change to disk itself (inline edits) — the harness
  // skips the editor fanout and commits straight away. Set for small/cohesive tasks where spawning
  // leaf editors would be pure overhead (the model is fast and holds a large context). The model
  // decides based on the sizing rule in WORKER_SYSTEM_PREFIX: fan out only when the work is large
  // (>~500 LOC) or needs debugging across many places. The harness phantom-guards every planned file
  // (git status), so a claimed `applied` with nothing on disk still surfaces as `blocked` rather than
  // producing an empty commit. Absent/false → fan out as usual.
  applied: z.boolean().optional(),
  // The ground the Coordinator already covered, handed forward to the editor leaves. A leaf's whole
  // brief used to be its entry's `purpose`, so every leaf re-surveyed the exact files the Coordinator
  // had just finished reading (observed: four leaves each re-read repository.ts / todo.ts / errors.ts
  // / biome.json / package.json). The Coordinator holds that knowledge at submit time, so it costs no
  // extra round-trip to carry it here. Distilled, never dumped: it is paid ×N across the fanout, so
  // it is capped at LEAF_CONTEXT_MAX and asked for as a task briefing (what to change, where, which
  // contract), not a context dump. Absent → leaf prompts are byte-identical to before.
  sharedContext: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Brief your editor leaves in 3-5 sentences: the conventions, file:line landmarks and contracts you already established that bear on THESE edits. Omit anything that would not change what a leaf types — leaves can still read the repo themselves.',
    ),
});
export type FileManifest = z.infer<typeof FileManifestSchema>;

export type WorkerAgent = ToolLoopAgent<never, WorkerTools>;

export type WorkerInput = {
  group: PrGroup;
  // The specific task this pass focuses on. When set, the manifest prompt and progress entries
  // scope to this single task; when omitted (the CI-fix / orchestrator-as-tool path) the Worker
  // plans across the whole group. The two-phase manifest/editor flow is unchanged either way.
  task?: Task;
  checkoutPath: string;
  baseBranch: string;
  styleContents: string;
  rollingContext: string;
  // Optional shell command run in the checkout before staging, so the committed diff matches
  // the project's formatter (LLM output rarely is byte-identical to biome/prettier/gofmt). When
  // unset, no format step runs. See issue #48.
  formatCommand?: string;
  // Optional shell command run in the checkout after the editor fanout and after formatCommand,
  // before any `git add`/`commit`. A non-zero exit triggers exactly one bounded local fix pass
  // (a task-scoped manifest+editor re-run fed the verify output); if it still fails the Worker
  // returns `blocked` without committing, so a red diff never reaches the remote. Unset → no
  // verify step (byte-identical to today). See issue #122.
  verifyCommand?: string;
  // Optional structured logger. When set, one event is emitted per verify invocation (command,
  // exit code, duration, whether a fix pass followed). Mirrors FixSessionInput.logger (issue #122).
  logger?: LoggerLike;
  // Optional harness context block prepended to the manifest (first user) message (issue #106).
  contextBlock?: string;
  // Optional trailing `<system-reminder>` (the run's Step N/M position) appended to the END of the
  // manifest (first user) message, kept out of the cacheable leading prefix (slice 04 §4).
  progressBlock?: string;
  // Optional handle from an earlier manifest-planning run (a prior CI-fix pass for this group). When
  // set, the manifest agent continues that conversation instead of planning fresh (issue #107).
  priorHandle?: SubagentHandle<WorkerTools>;
  // Optional outer abort signal (e.g. SIGINT, see cli.ts). When it aborts, the editor fanout's own
  // controller aborts too, so sibling editor LLM calls stop rather than burning tokens after the
  // run is already cancelled (cleanup #2, plan 02-signal-cancellation-cleanup).
  signal?: AbortSignal;
  // Optional cap on how many editor leaves run concurrently in the fanout pool. Unset →
  // EDITOR_CONCURRENCY_DEFAULT. Populated from the resolved `editorConcurrency` config key by the
  // run-loop adapter (issue #189); still optional so direct callers/tests may omit it.
  editorConcurrency?: number;
};

// Per-file outcome from the parallel editor fanout. Useful to the Orchestrator
// when composing the PR body and the (possibly squashed) commit message.
export type FileChange = {
  path: string;
  kind: 'create' | 'modify' | 'delete';
  summary: string;
};

export type WorkerDelivery = {
  branch: string;
  // Draft message Worker proposes; Orchestrator may rewrite before committing the final.
  draftCommitMessage: string;
  changes: FileChange[];
  // Per-task progress entries appended to .ai-task-master/progress.md.
  progressEntries: string[];
};

export type WorkerResult =
  // `handle` retains the manifest-planning conversation so the next CI-fix pass for this group can
  // continue it instead of re-planning from zero (issue #107).
  | { kind: 'ok'; delivery: WorkerDelivery; handle: SubagentHandle<WorkerTools> }
  // The Worker declared (via FileManifest.noChangesNeeded) that the task requires no code changes.
  // The task completes without a commit; nothing was branched, edited, or committed.
  | { kind: 'no-changes'; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

// The Coordinator's role prose lives behind the prompts seam (slice 08); re-exported for the wiring
// sites (run-loop-adapter, orchestrator subagent-tools, take-over/ci-fix flows) that feed it to
// buildRolePrompt. The per-file EDITOR_SYSTEM_PREFIX is imported above for the local editor fanout.
export { WORKER_SYSTEM_PREFIX } from './prompts/role-guidance.ts';

// Worker step budgets — single-sourced so each step-budget reminder (issue #105) matches the real
// cap. The manifest pass gets 30; each per-file editor fan-out gets 12.
export const WORKER_MAX_STEPS = 30;
export const EDITOR_MAX_STEPS = 12;

// Editor fanout shape. The manifest is grouped by directory so one leaf owns a cohesive slice of
// files instead of the fanout opening one provider call per file, and the groups run through a
// bounded pool. MAX_FILES_PER_EDITOR caps how many files a leaf owns (a large directory still spreads
// across several leaves); EDITOR_CONCURRENCY_DEFAULT caps how many leaves run at once so a big
// manifest can't open dozens of concurrent LLM requests. Bigger than a typical "one file per leaf":
// modern coding models finish a single file in seconds, so a leaf should own a meaty, multi-file
// chunk that keeps an editor working for minutes — aitm is built for big work. The per-run config
// that overrides the concurrency is wired separately; unset falls back to this default.
export const MAX_FILES_PER_EDITOR = 6;
export const EDITOR_CONCURRENCY_DEFAULT = 4;

// Mechanical floor under the fanout decision. WORKER_SYSTEM_PREFIX already tells the Coordinator to
// fan out only at scale, but prose is not a constraint: an observed run spawned four editors for four
// one-line edits (`db.test.ts (1), package.json #1 (1), index.ts (1), package.json #2 (1)`) — four
// agent spin-ups, four repo surveys, four leaf prompts, for work one leaf finishes in a single step.
// A leaf's fixed cost dominates trivial work, so below this floor the whole manifest runs inline in
// ONE editor pass. Only manifest data available at the decision point feeds the predicate:
//   - FANOUT_FLOOR_FILES (4): at/below MAX_FILES_PER_EDITOR, so the collapsed leaf still respects the
//     per-leaf cap. 4 is the observed pathological width; a 5+ file slice keeps fanning out.
//   - FANOUT_FLOOR_PURPOSE_CHARS (240): the Coordinator's own prose across the WHOLE manifest. It
//     writes a clause for a one-line edit ("expand the exports field") and a paragraph for a real
//     module, so total purpose length is the cheapest honest proxy for how much work it planned.
//     240 over up-to-4 files is ~60 chars each — one short sentence apiece.
//   - a `create` entry is never trivial: writing a new file from nothing is real code, so any create
//     in the manifest keeps the fanout regardless of the other two signals.
export const FANOUT_FLOOR_FILES = 4;
export const FANOUT_FLOOR_PURPOSE_CHARS = 240;

// Survey budget for the manifest-planning pass. Observed: one pass burned 12 minutes on ~40 read-only
// tool calls (readFile/glob/grep + `bash cat/ls/find`) before submitting a manifest for ONE file;
// another ran `bun install`, deleted node_modules and reinstalled — all while *planning*. Planning is
// not the phase that needs certainty; the editor leaves read the files they edit anyway. So once this
// many tool calls run without a single write, the pass gets one corrective reminder to submit with
// what it already knows. 20 is deliberately generous: a genuinely broad survey of an unfamiliar repo
// lands around 10-15 calls, so 20 clears real work while still catching the 40-call spiral at half
// its cost. It never fails the pass — it nudges, and the model finishes on its own terms.
export const MANIFEST_SURVEY_BUDGET = 20;

// Tool names that count as a WRITE for the survey budget. Everything else — including `bash` — counts
// as survey: the observed waste was `bash cat/ls/find` and `bun install` probing, and a Coordinator
// that genuinely edits inline reaches for writeFile/editFile/multiEdit (WORKER_SYSTEM_PREFIX's INLINE
// path), so classifying bash as survey is what makes the budget bite where it should.
const MANIFEST_WRITE_TOOLS: ReadonlySet<string> = new Set(['writeFile', 'editFile', 'multiEdit']);

// Module-private link from a Worker agent back to its init, so runWorker can spawn editor
// sub-agents with the same model + tool handles without exposing them on the public surface.
const workerInitRegistry = new WeakMap<WorkerAgent, SubagentInit<WorkerTools>>();

export function createWorkerAgent(init: SubagentInit<WorkerTools>): WorkerAgent {
  const agent = createSubagent<WorkerTools>(
    {
      model: init.model,
      tools: init.tools,
      systemPrompt: init.systemPrompt,
      submit: tool({
        description: 'Submit the file manifest (the FileManifest schema) for this PR group.',
        inputSchema: FileManifestSchema,
        execute: async (manifest) => manifest,
      }),
      ...(init.maxSteps !== undefined ? { maxSteps: init.maxSteps } : {}),
      // The survey budget composes ONTO the caller's prepareStep (compaction, deferred-tool
      // activation) rather than replacing it — one prepareStep slot, several policies.
      prepareStep: withSurveyBudget(init.prepareStep),
      ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
      ...(init.providerOptions !== undefined ? { providerOptions: init.providerOptions } : {}),
      ...(init.onStepFinish ? { onStepFinish: init.onStepFinish } : {}),
      ...(init.onRetry ? { onRetry: init.onRetry } : {}),
      ...(init.onStream ? { onStream: init.onStream } : {}),
      ...(init.streamWatchdog ? { streamWatchdog: init.streamWatchdog } : {}),
    },
    WORKER_MAX_STEPS,
  );
  workerInitRegistry.set(agent, init);
  return agent;
}

type WorkerPrepareStep = NonNullable<ToolLoopAgentSettings<never, WorkerTools>['prepareStep']>;

// How many tool calls the manifest pass has made since its last write. Resets to zero on any write, so
// a Coordinator taking the INLINE path (survey → write → survey → write) never accumulates a streak —
// only an unbroken run of pure surveying does.
export function readOnlyStreak(
  steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string }> }>,
): number {
  let streak = 0;
  for (const step of steps) {
    for (const call of step.toolCalls) {
      if (MANIFEST_WRITE_TOOLS.has(call.toolName)) streak = 0;
      else streak++;
    }
  }
  return streak;
}

// The nudge itself. Names the number so the model can see the budget is a measurement, not a mood, and
// points at the one action that ends the pass. Deliberately not a prohibition: the model may keep
// reading if it truly must — a hard stop here would trade a slow manifest for a wrong one.
export function surveyBudgetReminder(streak: number): string {
  return wrapReminder(
    [
      `You have made ${streak} read-only tool calls in a row without writing anything.`,
      'This is the planning phase, not the implementation phase — the editors you fan out re-read the',
      'files they own anyway. Call `submit` now with the manifest you can already justify: the files to',
      'create/modify/delete, each with its purpose, and `sharedContext` briefing your leaves on what you',
      'have already established. If a file is genuinely uncertain, say so in its purpose rather than',
      'reading more.',
    ].join(' '),
  );
}

// Compose the survey budget onto the caller's prepareStep. Once the pass crosses MANIFEST_SURVEY_BUDGET
// read-only calls it appends ONE corrective user message to that step's request; the SDK does not
// persist a prepareStep `messages` override across steps, so this is a single nudge rather than a
// standing instruction — which is the intent. It re-arms after the model writes something, so a long
// pass that surveys, writes, then spirals again gets nudged again.
function withSurveyBudget(base: WorkerPrepareStep | undefined): WorkerPrepareStep {
  let armed = true;
  return async (options) => {
    const result = await base?.(options);
    const streak = readOnlyStreak(options.steps);
    if (streak === 0) armed = true;
    if (!armed || streak < MANIFEST_SURVEY_BUDGET) return result;
    armed = false;
    const messages = result?.messages ?? options.messages;
    return {
      ...(result ?? {}),
      messages: [...messages, { role: 'user', content: surveyBudgetReminder(streak) }],
    };
  };
}

// The empty-manifest guidance (surfaced as a `blocked`). Extracted so the first pass and the
// verify fix pass share one message — weak/cheap coding models routinely return zero files here.
const EMPTY_MANIFEST_REASON =
  'The Worker returned an empty file manifest — the configured coding model produced no files to change for this PR group. This usually means the model is not capable enough to plan the work; try a more capable coding model (set `models.coding` in .ai-task-master/config.json or pass a stronger --model).';

// Hard ceiling for the verify call, matching the bash tool's MAX_BASH_TIMEOUT_MS (600s): a real
// test suite needs far longer than the tool's 60s default, and 600s is the largest it honors.
const VERIFY_TIMEOUT_MS = 600_000;
// Cap the verify output fed inline into the fix task / block reason so a megabyte of test output
// can't blow the fix-pass prompt or the WorkerResult reason.
const VERIFY_TAIL_MAX = 4000;

// Manifest-prompt interpolation caps (issue: prompt compression + injected-value fencing, slice 06).
// `group.title`/`task.text`/each subtask/`file.purpose` are short labels in the common case, but they
// originate from the Planner's (or a prior run's) structured output, not a fixed harness string — an
// unbounded field lets a runaway plan or a hostile task description blow up the manifest/editor prompt.
// Same discipline as VERIFY_TAIL_MAX, sized for a label rather than a failure tail.
const MANIFEST_FIELD_MAX = 500;
// `rollingContext` accumulates one summary per prior PR group across the whole run, so it grows with
// run length rather than staying label-sized; capped at the VERIFY_TAIL_MAX order of magnitude instead.
const ROLLING_CONTEXT_MAX = 4000;
// Editor leaves are the ones actually writing the code, so the budget has to fit the project style
// file that composeStyleGuide puts at the head of the guide (a typical CLAUDE.md runs 4-6k chars) —
// truncating it mid-rule is how a leaf ends up violating the house rules it was handed. The digest
// half tails it and is what gets cut when a repo ships an unusually long style file.
const EDITOR_STYLE_MAX = 6000;
// The Coordinator's hand-off digest is paid once per leaf, so it is capped far tighter than the style
// guide: ~800 chars is the "four sentences a colleague gives you before you start" the field asks for.
// A leaf buried in preamble writes worse code and costs ×N; anything longer, the leaf can go read.
const LEAF_CONTEXT_MAX = 800;

const TRUNCATION_MARKER = ' […truncated]';

// Slice-cap a raw interpolated field to `max` chars, appending a marker so truncation is visible
// rather than silently cutting off mid-sentence with no signal to the model or a reader of the prompt.
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const budget = Math.max(0, max - TRUNCATION_MARKER.length);
  return text.slice(0, budget) + TRUNCATION_MARKER;
}

export async function runWorker(agent: WorkerAgent, input: WorkerInput): Promise<WorkerResult> {
  const init = workerInitRegistry.get(agent);
  if (!init) {
    return {
      kind: 'error',
      error: 'runWorker called with an agent not built by createWorkerAgent',
    };
  }
  const branch = input.group.branch ?? `aitm/${input.group.id}`;
  try {
    const planned = await planAndEdit(agent, init, input, branch);
    if (planned.kind === 'blocked' || planned.kind === 'error' || planned.kind === 'no-changes') {
      // Nothing committed this pass, yet the planning agent (or a failed fix fanout) may have left
      // stray edits in the working tree — it holds the edit/write/bash tools and explores the diff
      // before submitting. The self-review "clean" case (an empty noChangesNeeded manifest) is the
      // canonical trigger: the reviewer can tweak a file, then declare nothing to fix. Restore a
      // clean tree so the shared in-place checkout stays deterministic — a later `checkout -B`
      // never resets uncommitted changes, so they would otherwise carry onto the next branch.
      await discardStrayEdits(init.tools.bash, input.checkoutPath);
      if (planned.kind === 'blocked') return { kind: 'blocked', reason: planned.reason };
      if (planned.kind === 'error') return { kind: 'error', error: planned.error };
      return { kind: 'no-changes', reason: planned.reason };
    }

    // delivery.changes must reflect every committed edit, so a fix pass that touched new files
    // is appended to the first-pass changes (the Orchestrator narrates the PR body off this).
    let changes = planned.changes;
    if (input.verifyCommand) {
      // Verify gate: format + verify, one bounded fix pass, commit only when green. A red diff
      // never reaches the remote when the operator has configured a verify command (issue #122).
      const gated = await commitWithVerify(agent, init, input, branch, planned.draftCommitMessage);
      if (gated.kind === 'blocked') {
        // The verify gate's failed fix left its edits uncommitted — restore a clean tree.
        await discardStrayEdits(init.tools.bash, input.checkoutPath);
        return { kind: 'blocked', reason: gated.reason };
      }
      if (gated.extraChanges.length > 0) changes = [...changes, ...gated.extraChanges];
    } else {
      // Branch already created by planAndEdit (branch-before-edit), so this only formats + commits.
      await commitOnBranch(init.tools.bash, input, planned.draftCommitMessage);
    }

    return {
      kind: 'ok',
      delivery: {
        branch,
        draftCommitMessage: planned.draftCommitMessage,
        changes,
        progressEntries: input.task
          ? [`- ${input.task.text}`]
          : input.group.tasks.map((task) => `- ${task.text}`),
      },
      handle: planned.handle,
    };
  } catch (err) {
    // A throw mid-pass (e.g. a bash fault during commit) can leave a half-staged tree. Restore it so
    // the next pass starts clean rather than carrying the partial mutation onto another branch.
    await discardStrayEdits(init.tools.bash, input.checkoutPath);
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

type PlanEditResult =
  | {
      kind: 'ok';
      changes: FileChange[];
      draftCommitMessage: string;
      handle: SubagentHandle<WorkerTools>;
    }
  | { kind: 'no-changes'; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

// Phase 1 + Phase 2 only: plan the file manifest, then fan editors out over it. No verify, no
// commit. Shared by the main pass and the single bounded verify fix pass — because the fix pass
// runs through here (which never verifies), it can never trigger a second fix pass.
async function planAndEdit(
  agent: WorkerAgent,
  init: SubagentInit<WorkerTools>,
  input: WorkerInput,
  branch: string,
): Promise<PlanEditResult> {
  const { submitted, handle } = await planManifest(agent, input, init.onUsage);
  if (!submitted.ok) {
    // Only after the schema-retry kernel exhausts. A model that never submits gets the same
    // capability guidance as a zero-file manifest; one that keeps mangling the schema is an error.
    if (submitted.reason === 'invalid') {
      return {
        kind: 'error',
        error: `worker manifest failed schema validation after retries: ${formatSubmitIssues(submitted.issues)}`,
      };
    }
    return { kind: 'blocked', reason: EMPTY_MANIFEST_REASON };
  }
  const manifest = submitted.value;
  if (manifest.files.length === 0) {
    // A reasoned empty manifest is a legitimate outcome (verification-only task, change already
    // in place) — complete without a commit. An unreasoned one keeps the weak-model diagnosis.
    if (manifest.noChangesNeeded) {
      return { kind: 'no-changes', reason: manifest.noChangesNeeded };
    }
    return { kind: 'blocked', reason: EMPTY_MANIFEST_REASON };
  }
  // Inline-edit path: the Coordinator declared `applied` — it wrote every planned change to disk
  // itself during planning (opencode-style: the agent decides when to delegate; the harness honors "I
  // did it myself"). The work-loop's acquire already checked out the group branch, so inline edits
  // landed there directly; checkoutBranch is a harmless no-op when already on it. Each planned file is
  // phantom-guarded (git status) so a claimed `applied` with nothing on disk blocks rather than an
  // empty commit — the same discipline the fanout path enforces per editor. Summary comes from each
  // entry's `purpose` (the Coordinator's own description); there are no editor texts to harvest.
  if (manifest.applied) {
    await checkoutBranch(requireExec(init.tools.bash), input, branch);
    const changes: FileChange[] = [];
    const unchanged: string[] = [];
    for (const file of manifest.files) {
      if (await editorTouchedPath(init.tools.bash, input.checkoutPath, file.path)) {
        changes.push({ path: file.path, kind: file.kind, summary: file.purpose });
      } else {
        unchanged.push(file.path);
      }
    }
    if (unchanged.length > 0) {
      return { kind: 'blocked', reason: appliedPhantomReason(unchanged) };
    }
    return { kind: 'ok', changes, draftCommitMessage: manifest.draftCommitMessage, handle };
  }
  // Create/switch the group branch BEFORE the editor fanout writes any file, so every edit lands on
  // the group branch from the start rather than on whatever branch is currently checked out. Under
  // the shared single checkout (worktrees removed), a `checkout -B` after the writes would otherwise
  // carry this group's — or a concurrent group's — uncommitted edits onto the wrong branch (audit 02).
  await checkoutBranch(requireExec(init.tools.bash), input, branch);
  const outcomes = await runEditorFanout(init, manifest, input);
  const changes: FileChange[] = [];
  const unchanged: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.changed) changes.push(outcome.change);
    else unchanged.push(outcome.path);
  }
  // A planned file the editor never wrote is a phantom edit: recording its FileChange would name a
  // file in the PR body and commit message that the diff does not contain. Fail the whole pass rather
  // than commit a partial (or misleading) result — same remediation as an empty manifest (audit 05).
  if (unchanged.length > 0) {
    return { kind: 'blocked', reason: editorNoChangeReason(unchanged) };
  }
  return { kind: 'ok', changes, draftCommitMessage: manifest.draftCommitMessage, handle };
}

// Guidance surfaced (as a `blocked`) when the manifest was non-empty but one or more editors returned
// a summary without writing anything on disk. Mirrors EMPTY_MANIFEST_REASON: the root cause is almost
// always a coding model too weak to edit, so the remediation is a more capable model.
function editorNoChangeReason(paths: string[]): string {
  return [
    `The coding model produced no on-disk change for ${paths.length === 1 ? 'a planned file' : 'planned files'}:`,
    `${paths.join(', ')}. The editor narrated the edit instead of writing it (a phantom edit), so nothing`,
    'was committed and no PR was opened. This usually means the coding model is not capable enough; try a',
    'more capable coding model (set `models.coding` in .ai-task-master/config.json or pass a stronger',
    '`--model`).',
  ].join(' ');
}

// Mirrors editorNoChangeReason for the inline path: the Coordinator declared `applied` but a planned
// file is unchanged on disk — it claimed an inline edit it never made (a phantom). Same root cause
// (a coding model too weak to edit) and the same remediation; only the wording differs.
function appliedPhantomReason(paths: string[]): string {
  return [
    `The Coordinator declared \`applied\` (inline edits) but left ${
      paths.length === 1 ? 'a planned file' : 'planned files'
    } unchanged on disk:`,
    `${paths.join(', ')}. Nothing was committed and no PR was opened — the coding model claimed it edited`,
    'inline but never wrote the change (a phantom edit). This usually means the coding model is not',
    'capable enough; try a more capable coding model (set `models.coding` in .ai-task-master/config.json',
    'or pass a stronger `--model`).',
  ].join(' ');
}

// Gate committing on `verifyCommand`. Branch checkout + format run first (verify must see the
// formatted files); then verify in the checkout. On a non-zero exit: exactly ONE bounded fix pass
// (a task-scoped manifest+editor re-run fed the verify output) + re-format + re-verify. Still red →
// `blocked` carrying the verify tail; nothing is staged or committed. Green → stage + commit,
// returning any files the fix pass touched so runWorker can fold them into the delivery.
async function commitWithVerify(
  agent: WorkerAgent,
  init: SubagentInit<WorkerTools>,
  input: WorkerInput,
  branch: string,
  message: string,
): Promise<{ kind: 'ok'; extraChanges: FileChange[] } | { kind: 'blocked'; reason: string }> {
  const exec = requireExec(init.tools.bash);
  // The group branch was already created by the first planAndEdit pass (branch-before-edit); verify
  // must see the formatted files, so format the checked-out branch before running verify.
  await runFormat(exec, input);

  let started = Date.now();
  let out = await runVerify(exec, input);

  // Formatter-first repair. A failed verify used to go straight to the model, which meant formatting
  // diagnostics — import order, a `"exports"` field wanting expansion — were handed to an LLM that
  // spawned a leaf per file to hand-edit them. `biome check --write` (or whatever formatCommand is)
  // fixes that whole class in milliseconds, deterministically. So re-run the formatter first and
  // re-verify; only what survives is worth a model fix pass. The formatter already ran before this
  // verify, but the fanout's edits are exactly what it needs to see — and it is idempotent, so on a
  // genuinely non-formatting failure this costs one no-op format plus one re-verify.
  const formatRepair = out.exitCode !== 0 && input.formatCommand !== undefined;
  logVerify(input, out, Date.now() - started, {
    formatRetryFollowed: formatRepair,
    fixPassFollowed: out.exitCode !== 0 && !formatRepair,
  });
  if (formatRepair) {
    await runFormat(exec, input);
    started = Date.now();
    out = await runVerify(exec, input);
    harnessProgress(
      `group ${input.group.id}: verify failed → formatted → re-verified (exit ${out.exitCode})`,
    );
    logVerify(input, out, Date.now() - started, {
      formatRetryFollowed: false,
      fixPassFollowed: out.exitCode !== 0,
    });
  }

  let extraChanges: FileChange[] = [];
  if (out.exitCode !== 0) {
    // One bounded fix pass. planAndEdit never verifies, so this cannot recurse. Its edits are
    // captured for the delivery; an empty/blocked fix manifest simply makes zero edits, and the
    // re-verify below is still authoritative (per the spec, a still-red gate blocks on the tail).
    const fixed = await planAndEdit(
      agent,
      init,
      {
        ...input,
        task: buildVerifyFixTask(input.group.id, out),
      },
      branch,
    );
    if (fixed.kind === 'ok') extraChanges = fixed.changes;
    await runFormat(exec, input);
    started = Date.now();
    out = await runVerify(exec, input);
    logVerify(input, out, Date.now() - started, {
      formatRetryFollowed: false,
      fixPassFollowed: false,
    });
    if (out.exitCode !== 0) {
      return { kind: 'blocked', reason: verifyBlockedReason(input.verifyCommand ?? '', out) };
    }
  }

  await stageAndCommit(exec, input, message);
  return { kind: 'ok', extraChanges };
}

// Retries a botched `submit` up to this many times (matches the runWithSchemaRetry default).
const MANIFEST_SCHEMA_RETRIES = 2;

// Plan the FileManifest, retaining the conversation as a handle for the next CI-fix pass (#107). A
// `priorHandle` continues that earlier conversation (the Worker remembers what it already tried)
// rather than planning fresh. Schema correction (#101) rides the SAME continuation mechanism — a
// botched `submit` is corrected in-conversation via continueSubagent before giving up.
async function planManifest(
  agent: WorkerAgent,
  input: WorkerInput,
  onUsage: OnUsage | undefined,
): Promise<{ submitted: SubmittedOutput<FileManifest>; handle: SubagentHandle<WorkerTools> }> {
  const prompt = buildManifestPrompt(input);
  let run = input.priorHandle
    ? await continueSubagent(input.priorHandle, prompt)
    : await runSubagent(agent, prompt);
  reportUsage(onUsage, run.result);
  let submitted = submittedOutput(run.result, FileManifestSchema);
  for (let attempt = 0; attempt < MANIFEST_SCHEMA_RETRIES && !submitted.ok; attempt++) {
    run = await continueSubagent(run.handle, correctiveMessage(submitted));
    reportUsage(onUsage, run.result);
    submitted = submittedOutput(run.result, FileManifestSchema);
  }
  return { submitted, handle: run.handle };
}

function buildManifestPrompt(input: WorkerInput): string {
  const lines = [
    `PR group: ${input.group.id} — ${capText(input.group.title, MANIFEST_FIELD_MAX)}`,
    `Branch: ${input.group.branch ?? `aitm/${input.group.id}`}`,
    `Base branch: ${input.baseBranch}`,
    `Checkout: ${input.checkoutPath}`,
    '',
  ];
  if (input.task) {
    lines.push(
      `Current task [${input.task.complexity}]: ${capText(input.task.text, MANIFEST_FIELD_MAX)}`,
    );
    if (input.task.subtasks && input.task.subtasks.length > 0) {
      lines.push(
        'Subtasks:',
        ...input.task.subtasks.map((s) => `  - ${capText(s, MANIFEST_FIELD_MAX)}`),
      );
    }
  } else {
    lines.push(
      'Tasks in this PR group:',
      ...input.group.tasks.map(
        (task, i) => `  ${i + 1}. ${capText(task.text, MANIFEST_FIELD_MAX)}`,
      ),
    );
  }
  if (input.rollingContext.trim()) {
    lines.push(
      '',
      'Rolling context from prior PRs:',
      capText(input.rollingContext, ROLLING_CONTEXT_MAX),
    );
  }
  lines.push(
    '',
    'Survey the repo, then call submit with the FileManifest.',
    'Include `sharedContext`: 3-5 sentences handing your editor leaves the ground you just covered — the conventions, the file:line landmarks, and the contract their edits must satisfy. Only what changes what they type; they can read the rest themselves.',
    'If the task genuinely requires no code changes (verification-only, or the change is already in place), submit an empty `files` list with `noChangesNeeded` explaining why — never invent edits to have something to commit.',
  );
  return appendReminderBlock(
    prependContextBlock(input.contextBlock, lines.join('\n')),
    input.progressBlock,
  );
}

// Strip the runtime-only extras the adapter may have mounted on the Worker tool set before the
// per-file fanout: editors never nest surveys (`explore`, issue #126), never touch durable memory
// (`memory`, issue #118), and never manage background processes (`bashOutput`/`killBash`, issue #103)
// — those belong to the manifest/ci-fix level. Absent → returned unchanged.
export function editorToolSet(tools: WorkerTools): WorkerTools {
  const {
    explore: _explore,
    memory: _memory,
    bashOutput: _bashOutput,
    killBash: _killBash,
    ...rest
  } = tools as WorkerTools & {
    explore?: Tool<unknown, unknown>;
    memory?: Tool<unknown, unknown>;
    bashOutput?: Tool<unknown, unknown>;
    killBash?: Tool<unknown, unknown>;
  };
  return rest as WorkerTools;
}

// Per-file editor result. `changed: false` marks a phantom edit — the model returned a summary but
// never wrote the file — so planAndEdit drops it and fails the pass instead of recording a FileChange
// the committed diff can't back.
type EditorOutcome = { changed: true; change: FileChange } | { changed: false; path: string };

// A manifest entry's grouping key: its immediate parent directory (POSIX manifest paths), or '.' for a
// repo-root file. Files under the same directory are cohesive, so they land on one leaf rather than
// fragmenting the fanout one-per-file.
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

// The base stream label naming one editor leaf: the lone file's basename for a single-file group
// (`login.ts`), or the shared parent directory for a multi-file leaf (`auth/`) — issue #131. Two
// leaves can still share a base (a chunked oversized directory, or same-basename files in sibling
// dirs); labelEditorGroups disambiguates those before the label reaches an operator.
function editorGroupLabel(group: readonly FileManifestEntry[]): string {
  const [first, ...rest] = group;
  if (!first) return '.';
  return rest.length === 0 ? basename(first.path) : `${dirOf(first.path)}/`;
}

// One editor leaf: the files it owns plus the distinct stream label naming it. Bundling the label with
// the files means the roster line, the per-editor completion line, and the onEditorStepFinish tag all
// read one already-disambiguated label instead of each re-deriving (and colliding on) it — issue #131.
type EditorLeaf = { label: string; files: FileManifestEntry[] };

// Turn directory groups into labeled leaves, disambiguating any shared base label (issue #131).
// editorGroupLabel is a pure function of a single group, so when groupManifestByDir chunks an oversized
// directory into several leaves they all resolve to the same `src/` — which makes the roster ambiguous
// (`src/ (3), src/ (2)`) and, worse, tags separate editors with an identical onEditorStepFinish stream
// line, defeating the per-editor labels. Any base shared by more than one leaf gets a ` #n` suffix in
// fanout order; a base owned by a single leaf stays bare, so the common one-leaf-per-directory case is
// byte-identical to before.
export function labelEditorGroups(groups: readonly FileManifestEntry[][]): EditorLeaf[] {
  const totals = new Map<string, number>();
  for (const group of groups) {
    const base = editorGroupLabel(group);
    totals.set(base, (totals.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return groups.map((files) => {
    const base = editorGroupLabel(files);
    if ((totals.get(base) ?? 0) <= 1) return { label: base, files };
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { label: `${base} #${n}`, files };
  });
}

// Is this manifest too small to be worth fanning out? See FANOUT_FLOOR_FILES for the constants and
// why these three signals. A one-file manifest is already a single leaf, so the floor has nothing to
// collapse there and returns false — that path stays byte-identical.
export function belowFanoutFloor(files: readonly FileManifestEntry[]): boolean {
  if (files.length <= 1 || files.length > FANOUT_FLOOR_FILES) return false;
  if (files.some((file) => file.kind === 'create')) return false;
  const purposeChars = files.reduce((total, file) => total + file.purpose.trim().length, 0);
  return purposeChars <= FANOUT_FLOOR_PURPOSE_CHARS;
}

// Stream label for the collapsed leaf. editorGroupLabel would name it after the FIRST entry's
// directory, which is a lie once the collapsed set spans directories — the whole point of the floor.
function collapsedLeafLabel(files: readonly FileManifestEntry[]): string {
  return `${files.length} small changes`;
}

// The fanout roster line (issue #131): `auth/ (2), login.ts (1)` — one entry per leaf, in fanout
// order, so an operator sees the team shape before any editor reports back.
function rosterSummary(leaves: readonly EditorLeaf[]): string {
  return leaves.map((leaf) => `${leaf.label} (${leaf.files.length})`).join(', ');
}

// One editor leaf's outcome, summarized for the roster's per-editor completion line (issue #131):
// how many of its files actually changed on disk vs. came back as a phantom (editorNoChangeReason
// reports the phantom paths separately once the whole fanout settles).
function outcomeSummary(outcomes: readonly EditorOutcome[]): string {
  const changed = outcomes.filter((o) => o.changed).length;
  const unchanged = outcomes.length - changed;
  return unchanged > 0 ? `${changed} changed, ${unchanged} unchanged` : `${changed} changed`;
}

// Group manifest entries into per-leaf assignments: entries sharing a parent directory go to the same
// leaf, and a directory with more than `maxPerGroup` entries is chunked to that size so no single leaf
// owns an unbounded brief while a large directory still spreads across the pool. Manifest order is
// preserved within and across groups so the fanout — and its tests — stay deterministic. A single-entry
// manifest yields one single-entry group, keeping that path byte-identical to the pre-team fanout.
export function groupManifestByDir(
  files: readonly FileManifestEntry[],
  maxPerGroup: number,
): FileManifestEntry[][] {
  const byDir = new Map<string, FileManifestEntry[]>();
  for (const file of files) {
    const dir = dirOf(file.path);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(file);
    else byDir.set(dir, [file]);
  }
  const size = Math.max(1, Math.floor(maxPerGroup) || 1);
  const groups: FileManifestEntry[][] = [];
  for (const bucket of byDir.values()) {
    for (let i = 0; i < bucket.length; i += size) {
      groups.push(bucket.slice(i, i + size));
    }
  }
  return groups;
}

// The shared "team brief" injected into every editor's system prompt when a manifest fans out to more
// than one leaf: the task in play, the whole file manifest (so each teammate sees what its siblings
// own, not just its own path), and the rolling cross-PR context. Built once per fanout. Values are
// slice-capped exactly as the manifest prompt caps them so a runaway plan can't blow the brief ×N. The
// caller injects it only for a real team (more than one group); a lone leaf sees no brief, keeping the
// single-leaf path byte-identical to the pre-team fanout.
export function buildTeamBrief(input: WorkerInput, files: readonly FileManifestEntry[]): string {
  const lines = [
    '<team-brief>',
    'You are one editor on a team realizing this change together; each leaf owns a different set of files.',
    '',
  ];
  if (input.task) {
    lines.push(`Task [${input.task.complexity}]: ${capText(input.task.text, MANIFEST_FIELD_MAX)}`);
  } else {
    lines.push(
      'Tasks in this change:',
      ...input.group.tasks.map((t) => `  - ${capText(t.text, MANIFEST_FIELD_MAX)}`),
    );
  }
  lines.push('', 'Full file manifest (each file is owned by exactly one leaf):');
  for (const file of files) {
    lines.push(`  - ${file.path} (${file.kind}) — ${capText(file.purpose, MANIFEST_FIELD_MAX)}`);
  }
  if (input.rollingContext.trim()) {
    lines.push(
      '',
      'Rolling context from prior PRs:',
      capText(input.rollingContext, ROLLING_CONTEXT_MAX),
    );
  }
  lines.push(
    '',
    'Edit only the file(s) named in your own brief below; treat the rest of the manifest as your',
    "teammates' contract, not files for you to touch.",
    '</team-brief>',
  );
  return lines.join('\n');
}

// Fan the manifest out over a bounded pool of editor leaves, sharing a single AbortController: any leaf
// rejecting (or the outer WorkerInput.signal aborting, e.g. SIGINT) aborts every sibling's in-flight
// `generateText` call so a doomed fanout stops burning tokens instead of running to completion (cleanup
// #2, plan 02-signal-cancellation-cleanup). The manifest is grouped by directory first so one leaf owns
// cohesive files, then at most `editorConcurrency` leaves run at once — a big manifest no longer opens
// one concurrent LLM request per file (slice 05). Each leaf yields one outcome per file it owns; the
// per-group results are flattened back to one outcome per manifest entry for planAndEdit.
async function runEditorFanout(
  init: SubagentInit<WorkerTools>,
  manifest: FileManifest,
  input: WorkerInput,
): Promise<EditorOutcome[]> {
  const files = manifest.files;
  const controller = new AbortController();
  const outer = input.signal;
  const onOuterAbort = (): void => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const collapse = belowFanoutFloor(files);
  if (collapse) {
    harnessProgress(
      `group ${input.group.id}: manifest below the fanout floor (${files.length} small changes) — running them in one pass`,
    );
  }
  const leaves = collapse
    ? [{ label: collapsedLeafLabel(files), files: [...files] }]
    : labelEditorGroups(groupManifestByDir(files, MAX_FILES_PER_EDITOR));
  // A team brief only makes sense once the work is actually split across leaves; a lone leaf already
  // sees its whole assignment in its own prompt, and injecting nothing keeps that path byte-identical.
  // The roster/per-editor-outcome lines gate on the same condition (issue #131) — a lone leaf stays
  // byte-identical to the pre-team fanout, silence included.
  const isTeam = leaves.length > 1;
  const teamBrief = isTeam ? buildTeamBrief(input, files) : '';
  const concurrency = input.editorConcurrency ?? EDITOR_CONCURRENCY_DEFAULT;
  if (isTeam) {
    harnessProgress(
      `group ${input.group.id}: fanning out ${leaves.length} editors — ${rosterSummary(leaves)}`,
    );
  }
  try {
    const perLeaf = await runPool(leaves, concurrency, (leaf) =>
      runEditor(init, leaf, input, controller.signal, teamBrief, manifest.sharedContext)
        .then((outcomes) => {
          if (isTeam) {
            harnessProgress(
              `group ${input.group.id}: editor ${leaf.label} done — ${outcomeSummary(outcomes)}`,
            );
          }
          return outcomes;
        })
        .catch((err: unknown) => {
          controller.abort();
          throw err;
        }),
    );
    return perLeaf.flat();
  } finally {
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

// One leaf, with exactly one retry for phantom edits. A leaf that narrates ("I updated the routes")
// without calling a write tool used to block the WHOLE task — an observed run shipped a PR with its
// services and none of its routes for that reason. Blocking is too blunt for a failure the model can
// usually fix once it is told plainly what happened, so the unwritten files get one corrective pass.
// Exactly one: a second narration after being told "you wrote nothing" is a real capability failure,
// and retrying it again would just burn a leaf's worth of tokens before blocking anyway.
async function runEditor(
  init: SubagentInit<WorkerTools>,
  leaf: EditorLeaf,
  input: WorkerInput,
  signal: AbortSignal,
  teamBrief: string,
  sharedContext: string | undefined,
): Promise<EditorOutcome[]> {
  const group = leaf.files;
  const summary = await runEditorPass(
    init,
    leaf,
    input,
    signal,
    teamBrief,
    buildEditorPrompt(group, input, sharedContext),
  );
  const outcomes = await verifyEditorOutcomes(init, input, group, summary);
  const phantoms = group.filter((file) => outcomes.some((o) => !o.changed && o.path === file.path));
  if (phantoms.length === 0) return outcomes;

  harnessProgress(
    `group ${input.group.id}: ${leaf.label} narrated ${phantoms.length === 1 ? 'an edit' : `${phantoms.length} edits`} without writing — retrying once`,
  );
  const retrySummary = await runEditorPass(
    init,
    leaf,
    input,
    signal,
    teamBrief,
    buildPhantomRetryPrompt(phantoms, input, sharedContext),
  );
  const retried = await verifyEditorOutcomes(init, input, phantoms, retrySummary || summary);
  const byPath = new Map(retried.map((o) => [o.changed ? o.change.path : o.path, o]));
  return outcomes.map((o) => (o.changed ? o : (byPath.get(o.path) ?? o)));
}

// One generateText call for a leaf, returning its one-line summary ('' when it said nothing).
async function runEditorPass(
  init: SubagentInit<WorkerTools>,
  leaf: EditorLeaf,
  input: WorkerInput,
  signal: AbortSignal,
  teamBrief: string,
  prompt: string,
): Promise<string> {
  // Per-editor label (issue #131): each leaf gets its own onStepFinish instance, tagged with the
  // already-disambiguated label naming what it owns, rather than every leaf sharing one anonymous
  // "editor" stream line — chunked-directory leaves no longer collide on that tag.
  const editorStepFinish = init.onEditorStepFinish?.(leaf.label);
  const result = await callWithStepTimeout(
    () =>
      generateText({
        model: init.model,
        tools: editorToolSet(init.tools),
        system: buildEditorRolePrompt({
          style: capText(input.styleContents, EDITOR_STYLE_MAX),
          roleGuidance: EDITOR_SYSTEM_PREFIX,
          cwd: input.checkoutPath,
          maxSteps: EDITOR_MAX_STEPS,
          // Empty for a lone leaf → the slot is omitted and the system prompt is byte-identical to today.
          ...(teamBrief ? { teamBrief } : {}),
        }),
        prompt,
        stopWhen: stepCountIs(EDITOR_MAX_STEPS),
        abortSignal: signal,
        // web_search (issue #112) rides providerOptions.openrouter when the adapter enabled it for
        // this Worker. The old `{ openai: { parallelToolCalls: true } }` was dead — the OpenRouter
        // provider ignores the `openai` namespace, and parallelToolCalls is already an OpenRouter
        // chat-setting default (true), so dropping it changes no request bytes.
        ...(init.providerOptions !== undefined ? { providerOptions: init.providerOptions } : {}),
        ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
        // Editor-fanout progress (silent-run fix): per-step-field-only handlers, safe under the
        // parallel fanout — see SubagentInit.onEditorStepFinish.
        ...(editorStepFinish ? { onStepFinish: editorStepFinish } : {}),
      }),
    init.timeout,
  );
  reportUsage(init.onUsage, result); // per-leaf editor pass, recorded under the worker role (#114)
  const firstLine = result.text.trim().split('\n')[0];
  return firstLine && firstLine.length > 0 ? firstLine : '';
}

// Confirm EACH planned file diverged on disk before recording its change: a weak model can narrate an
// edit ("edited x") — or write two of its three files and narrate the third — without calling
// writeFile/editFile, and every unwritten path must surface as a phantom rather than a FileChange the
// committed diff can't back (audit 05).
async function verifyEditorOutcomes(
  init: SubagentInit<WorkerTools>,
  input: WorkerInput,
  group: readonly FileManifestEntry[],
  summary: string,
): Promise<EditorOutcome[]> {
  const outcomes: EditorOutcome[] = [];
  for (const file of group) {
    if (await editorTouchedPath(init.tools.bash, input.checkoutPath, file.path)) {
      outcomes.push({
        changed: true,
        change: {
          path: file.path,
          kind: file.kind,
          summary: summary || `${file.kind} ${file.path}`,
        },
      });
    } else {
      outcomes.push({ changed: false, path: file.path });
    }
  }
  return outcomes;
}

// Did the editor actually change this path on disk? `git status --porcelain` reports create (`??`),
// modify (` M`) and delete (` D`) as a non-empty line and stays empty when the tree is unchanged —
// exactly the no-diff-is-failure signal. `--no-optional-locks` keeps the parallel per-file checks off
// the shared index.lock so concurrent editors don't race on it. A non-zero exit is a real git fault,
// not a no-op edit, so it surfaces as an error rather than a silent phantom.
async function editorTouchedPath(
  bash: Tool<BashInput, BashOutput>,
  checkoutPath: string,
  filePath: string,
): Promise<boolean> {
  const exec = requireExec(bash);
  const command = `git -C ${shQuote(checkoutPath)} --no-optional-locks status --porcelain -- ${shQuote(filePath)}`;
  const out = await exec(
    { command, description: 'verify the editor changed the file on disk' },
    { toolCallId: `worker-status-${Date.now()}`, messages: [] },
  );
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  if (out.exitCode !== 0) {
    throw new Error(`git status failed (${out.exitCode}) verifying ${filePath}\n${out.stderr}`);
  }
  return out.stdout.trim().length > 0;
}

// The head of a leaf's prompt: the ground the Coordinator already covered, plus the harness facts a
// leaf otherwise rediscovers or gets wrong. Everything here is data that already exists at this point
// — no extra model round-trip — and each line changes what the leaf types:
//   - `sharedContext`: the Coordinator's own hand-off digest (conventions, landmarks, contracts), so a
//     leaf does not re-survey the files the Coordinator just finished reading.
//   - the verify command: the bar the edit has to clear, which the leaf would otherwise only learn
//     about after the gate fails and a fix pass is spent on it.
//   - the format command: the harness runs it after the fanout, so hand-fixing import order or
//     whitespace is wasted work (an observed run spent four leaves doing exactly that).
// All three absent → empty, and the leaf prompt is byte-identical to the pre-hand-off shape.
function buildLeafContext(input: WorkerInput, sharedContext: string | undefined): string[] {
  const lines: string[] = [];
  if (sharedContext?.trim()) {
    lines.push(
      'What the coordinator already established:',
      capText(sharedContext, LEAF_CONTEXT_MAX),
    );
  }
  if (input.verifyCommand) {
    lines.push(`Your change must survive \`${capText(input.verifyCommand, MANIFEST_FIELD_MAX)}\`.`);
  }
  if (input.formatCommand) {
    lines.push(
      `\`${capText(input.formatCommand, MANIFEST_FIELD_MAX)}\` runs after you — do not hand-fix formatting or import order.`,
    );
  }
  return lines.length > 0 ? [...lines, ''] : lines;
}

function buildEditorPrompt(
  group: readonly FileManifestEntry[],
  input: WorkerInput,
  sharedContext?: string,
): string {
  const head = [`Checkout: ${input.checkoutPath}`, ...buildLeafContext(input, sharedContext)];
  const [first, ...rest] = group;
  // A single-file group is byte-identical to the pre-team per-file prompt (the common case).
  if (first && rest.length === 0) {
    return [
      ...head,
      `File: ${first.path}`,
      `Change kind: ${first.kind}`,
      `Purpose: ${capText(first.purpose, MANIFEST_FIELD_MAX)}`,
      '',
      'Make the change. Reply with a one-line summary.',
    ].join('\n');
  }
  const lines = [...head, `You own these ${group.length} files:`, ''];
  for (const file of group) {
    lines.push(
      `File: ${file.path}`,
      `Change kind: ${file.kind}`,
      `Purpose: ${capText(file.purpose, MANIFEST_FIELD_MAX)}`,
      '',
    );
  }
  lines.push('Make each change. Reply with a one-line summary.');
  return lines.join('\n');
}

// The single corrective retry for a leaf that narrated instead of writing. It names the failure
// explicitly rather than re-issuing the original brief: the model already believes it did the work, so
// repeating the request unchanged tends to produce the same narration. Scoped to the unwritten files
// only — whatever the leaf really did write stays committed as-is.
export function buildPhantomRetryPrompt(
  phantoms: readonly FileManifestEntry[],
  input: WorkerInput,
  sharedContext?: string,
): string {
  const lines = [
    `Checkout: ${input.checkoutPath}`,
    ...buildLeafContext(input, sharedContext),
    `You described ${phantoms.length === 1 ? 'this change' : 'these changes'} but wrote nothing — the file${
      phantoms.length === 1 ? ' is' : 's are'
    } unchanged on disk. Make the edit now with the write/edit tool; do not reply with a description of it.`,
    '',
  ];
  for (const file of phantoms) {
    lines.push(
      `File: ${file.path}`,
      `Change kind: ${file.kind}`,
      `Purpose: ${capText(file.purpose, MANIFEST_FIELD_MAX)}`,
      '',
    );
  }
  lines.push('Reply with a one-line summary only after the write tool has returned.');
  return lines.join('\n');
}

async function commitOnBranch(
  bash: Tool<BashInput, BashOutput>,
  input: WorkerInput,
  message: string,
): Promise<void> {
  const exec = requireExec(bash);
  // Branch already created by planAndEdit (branch-before-edit); only format + stage + commit remain.
  await runFormat(exec, input);
  await stageAndCommit(exec, input, message);
}

// Create/switch the group branch. Invoked from planAndEdit BEFORE the editor fanout so edits land on
// the group branch from the start (audit 02). `-B` with no start-point sets the branch to the current
// HEAD — a no-op when the branch is already checked out (e.g. the reused verify fix pass), and it
// never discards committed work. The driver acquires its checkout mutex around the whole
// checkout→edit→commit span so a concurrent group can't switch the shared tree mid-pass.
async function checkoutBranch(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
  branch: string,
): Promise<void> {
  await runBash(exec, `git -C ${shQuote(input.checkoutPath)} checkout -B ${shQuote(branch)}`);
}

// aitm's own state dir, relative to the checkout root. Every git command in this module that could
// otherwise sweep it into a commit — or delete it — names it, so the three call sites agree.
const STATE_DIR = '.ai-task-master';

// Stage (excluding aitm's own state dir) + commit — the post-verify steps shared by both paths.
// Excluding `.ai-task-master/` keeps our state.json/goal out of the target-repo commit even when
// the target repo does not gitignore it; the `:!` pathspec leaves its tracked files untouched.
async function stageAndCommit(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
  message: string,
): Promise<void> {
  const wt = shQuote(input.checkoutPath);
  // Stage everything, then UNSTAGE aitm's own state dir. `git add -A -- ':!.ai-task-master'` throws
  // "paths are ignored" when .ai-task-master is gitignored (the in-place case: the state dir sits at
  // the repo root and most repos ignore it) — naming an ignored path in a pathspec trips git. Plain
  // `add -A` skips ignored files silently; the `reset` then also drops the dir if it ISN'T ignored,
  // so aitm never commits its own state either way. No-op (exit 0) when nothing was staged for it.
  await runBash(exec, `git -C ${wt} add -A`);
  await runBash(exec, `git -C ${wt} reset -q -- ${STATE_DIR}`);
  await runBash(exec, `git -C ${wt} commit -m ${shQuote(message)}`);
}

// Restore the checkout to a clean tree after a worker pass that committed nothing. The planning
// agent and any fix-pass fanout can leave edits behind (an empty manifest declared clean — the
// self-review "clean" case — a blocked fix, a phantom edit, a verify failure, or a mid-commit
// throw), and the shared in-place checkout never auto-resets uncommitted changes: a later
// `checkout -B` carries them onto whatever branch comes next, so a stray edit surfaced post-merge
// as an uncommitted file (the README.md leftover). When the tree is dirty, reset tracked files to
// HEAD and drop untracked ones. aitm's own state dir must survive that: `git clean` without `-x`
// spares it only when the TARGET repo happens to gitignore it, so `-e .ai-task-master` protects it
// when the repo does not — otherwise this cleanup deletes the run's own plan, style cache, generated
// specialists, and scratch mid-run (same guard as InPlaceCheckout.ensureCleanTree). For the same
// reason the dirty check ignores state-dir entries: in a repo that doesn't ignore it, the untracked
// state dir alone would read as "dirty" and hard-reset the tree on every non-committing pass.
// A clean tree is a no-op (one cheap status check). Best-effort: a cleanup fault never masks the
// worker's real result. Safe because a successful stageAndCommit already captured any real work;
// whatever remains is, by definition, not meant to ship.
async function discardStrayEdits(
  bash: Tool<BashInput, BashOutput>,
  checkoutPath: string,
): Promise<void> {
  const exec = bash?.execute;
  if (typeof exec !== 'function') return; // best-effort: no cleanup without a runnable bash tool
  const wt = shQuote(checkoutPath);
  const out = await exec(
    {
      command: `git -C ${wt} status --porcelain`,
      description: 'check for stray edits left by a non-committing worker pass',
    },
    { toolCallId: `worker-tree-status-${Date.now()}`, messages: [] },
  );
  if (isAsyncIterable(out)) return;
  if (out.exitCode !== 0) return;
  if (!hasStrayEdit(out.stdout)) return;
  for (const command of [
    `git -C ${wt} reset --hard HEAD`,
    `git -C ${wt} clean -fd -e ${STATE_DIR}`,
  ]) {
    try {
      await runBash(exec, command);
    } catch {
      // best-effort: never mask the worker's real result with a cleanup failure
    }
  }
}

// Does this `git status --porcelain` output show anything worth cleaning? State-dir entries do not
// count: in a repo that does not gitignore `.ai-task-master`, its own untracked files would
// otherwise make every tree look dirty. Exported for the unit test of that exact case.
export function hasStrayEdit(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .some((line) => line.trim() !== '' && !line.slice(3).startsWith(STATE_DIR));
}

function requireExec(
  bash: Tool<BashInput, BashOutput>,
): NonNullable<Tool<BashInput, BashOutput>['execute']> {
  const exec = bash.execute;
  if (typeof exec !== 'function') {
    throw new Error('bash tool is missing an execute function');
  }
  return exec;
}

// Format BEFORE staging (and before verify) so the committed diff matches the project's formatter
// — LLM output is rarely byte-identical to biome/prettier/gofmt, and a format-gated CI would
// otherwise reject an otherwise-correct PR (issue #48). A non-zero exit (e.g. unfixable lint
// errors) surfaces as a worker error rather than a silent CI failure later.
async function runFormat(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
): Promise<void> {
  if (!input.formatCommand) return;
  await runBash(exec, `cd ${shQuote(input.checkoutPath)} && ${input.formatCommand}`);
}

// Run the verify command in the checkout and return its raw outcome. Unlike runBash it never
// throws on a non-zero exit — a failing verify is a handled outcome the gate reacts to, so it
// reads exitCode/stdout/stderr off BashOutput directly. Carries the hard-ceiling timeout so a
// real test suite isn't cut off at the bash tool's 60s default (issue #122).
async function runVerify(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
): Promise<BashOutput> {
  const command = `cd ${shQuote(input.checkoutPath)} && ${input.verifyCommand}`;
  const out = await exec(
    { command, description: 'run the configured verify command', timeoutMs: VERIFY_TIMEOUT_MS },
    { toolCallId: `worker-verify-${Date.now()}`, messages: [] },
  );
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  return out;
}

// One event per verify invocation, naming what the harness did about it: re-ran the formatter and
// re-verified (the cheap deterministic repair), spent the one bounded model fix pass, or neither.
function logVerify(
  input: WorkerInput,
  out: BashOutput,
  durationMs: number,
  followed: { formatRetryFollowed: boolean; fixPassFollowed: boolean },
): void {
  input.logger?.info('worker: verify', {
    command: input.verifyCommand,
    exitCode: out.exitCode,
    durationMs,
    ...followed,
  });
}

// The single bounded fix task: fix whatever the verify command reported. Scoped as one `task` so
// the Worker's manifest prompt targets the fix instead of re-planning the group; mirrors the
// CI-fix session's buildFixTask shape (ci-fix.ts).
function buildVerifyFixTask(groupId: string, out: BashOutput): Task {
  const text = [
    'The project verify command failed after your edits. Fix every error it reports so the verify',
    'command exits zero — change only what the failures require.',
    '',
    'Verify output (tail):',
    verifyOutputTail(out),
  ].join('\n');
  return { id: `${groupId}-verify-fix`, text, complexity: 'complex', done: false };
}

function verifyBlockedReason(verifyCommand: string, out: BashOutput): string {
  return [
    `The verify command (\`${verifyCommand}\`) still failed (exit ${out.exitCode}) after one local fix`,
    'pass — nothing was committed and no PR was opened. Fix the errors and re-run, or configure a',
    'more capable coding model.',
    '',
    'Verify output (tail):',
    verifyOutputTail(out),
  ].join('\n');
}

// Last VERIFY_TAIL_MAX chars of combined stdout+stderr — the failure tail is what a fixer needs.
function verifyOutputTail(out: BashOutput): string {
  const combined = [out.stdout, out.stderr]
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
    .join('\n');
  return combined.length > VERIFY_TAIL_MAX ? combined.slice(-VERIFY_TAIL_MAX) : combined;
}

async function runBash(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  command: string,
): Promise<void> {
  const out = await exec(
    { command, description: 'worker commit-phase git/format step' },
    { toolCallId: `worker-bash-${Date.now()}`, messages: [] },
  );
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  if (out.exitCode !== 0) {
    throw new Error(`bash failed (${out.exitCode}): ${command}\n${out.stderr}`);
  }
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return v !== null && typeof v === 'object' && Symbol.asyncIterator in (v as object);
}

// POSIX shell-quote: wrap in single quotes, escape embedded single quotes.
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

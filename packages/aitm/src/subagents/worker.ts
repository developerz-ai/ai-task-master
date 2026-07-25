// docs/subagents.md (Worker row), docs/task-groups.md, docs/commands/start.md
// One PR group: produce file changes + commits on a dedicated branch. Does NOT open the PR
// and does NOT finalize the commit message — those belong to the Orchestrator (more reliable
// at composing global-context narration: PR title, body, squash commit message).
//
// Strategy for *really big PRs* (the explicit design goal) — two layers of parallelism:
//
//   Layer A (outer, across files): plan a file manifest via the `submit` tool that lists every
//   file to create/modify/delete (docs/vendor/ai-sdk/chunk-09.md §"Orchestrator-Worker"),
//   then Promise.all over per-file editor sub-subagents — dispatched by editor-fanout.ts.
//
//   Layer B (inner, within one step): each editor enables `parallelToolCalls: true` (default
//   in the SDK — chunk-02.md §"parallelToolCalls") so the model can issue multiple readFile /
//   writeFile tool calls in a single step and the runtime executes them concurrently.
//
// This module holds the public contract (WorkerInput/WorkerResult/WorkerTools/FileManifest), the
// manifest-planning phase, and `runWorker`'s orchestration across three phase modules:
//   - editor-fanout.ts: dispatches the per-file editor subagents over a planned manifest.
//   - git-commit-phase.ts: branch checkout, format, stage, commit (+ the verify-gated variant).
//   - verify-gate.ts: runs the operator's verifyCommand and interprets pass/fail.
//
// SDK references:
//   chunk-09.md §"Orchestrator-Worker" (manifest + per-file workers)
//   chunk-09.md §"Subagents" §"Controlling What the Model Sees" (toModelOutput one-line summary)
//   chunk-04.md §"ToolLoopAgent" (agent class)
//   chunk-02.md §"Tool Calling" (parallelToolCalls)

import { randomUUID } from 'node:crypto';
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
  continueSubagent,
  correctiveMessage,
  createSubagent,
  formatSubmitIssues,
  runSubagent,
  type SubagentHandle,
  type SubmittedOutput,
  submittedOutput,
  wrapReminder,
} from '@developerz.ai/ai-claude-compat';
import type { Tool, ToolLoopAgent, ToolLoopAgentSettings } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import type { PrGroup } from '../domain/pr-group.ts';
import type { Task } from '../domain/task.ts';
import type { FileChange, WorkerDelivery } from '../domain/worker-delivery.ts';
import type { LoggerLike } from '../logger/logger.ts';
import { harnessProgress } from '../observability/step-progress.ts';
import type { DatetimeInput, DatetimeOutput } from '../tools/datetime.ts';
import type { WebFetchInput, WebFetchOutput } from '../tools/web-fetch.ts';
import type { WebSearchInput, WebSearchOutput } from '../tools/web-search.ts';
import { isAsyncIterable, requireExec, shQuote } from './bash-exec.ts';
import { type EditorOutcome, editorTouchedPath, runEditorFanout } from './editor-fanout.ts';
import {
  AGENT_STEP_BACKSTOP,
  appendReminderBlock,
  forwardInit,
  type OnUsage,
  prependContextBlock,
  reportUsage,
  type WorkerSubagentInit,
} from './factory.ts';
import { checkoutBranch, commitOnBranch, commitWithVerify } from './git-commit-phase.ts';
import { capText, MANIFEST_FIELD_MAX, ROLLING_CONTEXT_MAX } from './prompt-caps.ts';
import { discardStrayEdits } from './stray-edits.ts';

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
  // The failing verify command's output, ALREADY rendered as a `<verify-output>` data envelope
  // (renderVerifyFailure). Set only for the verify gate's fix pass (commitWithVerify). Untrusted —
  // a test can print "ignore previous instructions" — so it rides a fenced data block, not the
  // trusted `task.text` label; the Coordinator sees the full source-bounded tail rather than the
  // ~350 chars that survived the MANIFEST_FIELD_MAX cap when it was smuggled through task.text.
  verifyFailureBlock?: string;
  // Optional outer abort signal (e.g. SIGINT, see cli.ts). When it aborts, the editor fanout's own
  // controller aborts too, so sibling editor LLM calls stop rather than burning tokens after the
  // run is already cancelled (cleanup #2, plan 02-signal-cancellation-cleanup).
  signal?: AbortSignal;
  // Optional cap on how many editor leaves run concurrently in the fanout pool. Unset →
  // SUBAGENT_LIMIT_DEFAULT. Populated from the resolved `subagentLimit` config key by the run-loop
  // adapter (issue #189) — the same knob that bounds a scout wave, since an operator throttling a
  // rate-limited endpoint means "fewer agents at once", not "fewer editors". Still optional so
  // direct callers/tests may omit it.
  subagentLimit?: number;
  // Set by the self-review pass, the one caller whose Coordinator is expected to fix what it finds
  // with its own tools mid-review rather than delegate. When set, a manifest whose every file was
  // edited during planning is treated as `applied` even without the flag, so the fanout does not
  // re-do finished work. Off everywhere else: the normal worker path must keep planning and editing
  // as distinct phases. See planAndEdit.
  inlineEditsExpected?: boolean;
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

// `MANIFEST_FIELD_MAX` moved to prompt-caps.ts (shared with editor-fanout.ts's team-brief/editor
// prompts); re-exported here so existing callers (e.g. orchestrator.ts, capping its own interpolated
// Planner/Worker/editor fields at the same bound) keep importing it from worker.ts.
export { MANIFEST_FIELD_MAX } from './prompt-caps.ts';
// The Coordinator's role prose lives behind the prompts seam (slice 08); re-exported for the wiring
// sites (run-loop-adapter, take-over/ci-fix flows) that feed it to buildRolePrompt. The per-file
// EDITOR_SYSTEM_PREFIX lives behind editor-fanout.ts's own import of it.
export { WORKER_SYSTEM_PREFIX } from './prompts/role-guidance.ts';

// Worker step cap — the shared runaway backstop, not a work budget. The Coordinator's manifest pass
// terminates by calling `submit`; this cap only guards a non-terminating loop. See AGENT_STEP_BACKSTOP.
export const WORKER_MAX_STEPS = AGENT_STEP_BACKSTOP;

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
const workerInitRegistry = new WeakMap<WorkerAgent, WorkerSubagentInit<WorkerTools>>();

export function createWorkerAgent(init: WorkerSubagentInit<WorkerTools>): WorkerAgent {
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
      ...forwardInit(init),
      // The survey budget composes ONTO the caller's prepareStep (compaction, deferred-tool
      // activation) rather than replacing it — one prepareStep slot, several policies. Set after the
      // forwarded init so it wins over the plain passthrough.
      prepareStep: withSurveyBudget(init.prepareStep),
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
      // The fix pass itself (planAndEdit) is supplied as a closure so git-commit-phase.ts never
      // needs to import worker.ts's value exports (which would cycle the module graph back here).
      const gated = await commitWithVerify(
        init.tools.bash,
        input,
        branch,
        planned,
        (fixInput, fixBranch) =>
          planAndEdit(agent, init, { ...fixInput, priorHandle: planned.handle }, fixBranch),
      );
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

// Phase 1 + Phase 2 only: plan the file manifest, then fan editors out over it (editor-fanout.ts). No
// verify, no commit. Shared by the main pass and the single bounded verify fix pass — because the fix
// pass runs through here (which never verifies), it can never trigger a second fix pass.
async function planAndEdit(
  agent: WorkerAgent,
  init: WorkerSubagentInit<WorkerTools>,
  input: WorkerInput,
  branch: string,
): Promise<PlanEditResult> {
  // Self-review takes a pre-planning snapshot to power the inline-edit inference, and that snapshot
  // must be on the group branch the planner then edits — so in that mode alone, check out first. The
  // normal path defers its checkout until it knows there is work to commit (byte-identical to before
  // this inference existed). `undefined` from dirtyPaths means the snapshot could not be taken, which
  // disables the inference rather than guessing — an empty baseline would make inherited-dirty files
  // look newly edited and wrongly skip the fanout on work the pass never did.
  const takeSnapshot = input.inlineEditsExpected === true;
  if (takeSnapshot) await checkoutBranch(requireExec(init.tools.bash), input, branch);
  const dirtyBefore = takeSnapshot
    ? await dirtyPaths(init.tools.bash, input.checkoutPath)
    : EMPTY_PATHS;
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
  // There is work to commit. Check out the group branch now (a no-op when self-review already did it
  // above) so both the inline and fanout paths observe and land on the same branch — a `checkout -B`
  // after the writes would carry uncommitted edits onto the wrong branch (audit 02). A no-changes or
  // empty manifest returned above without ever switching, keeping the normal path byte-identical.
  await checkoutBranch(requireExec(init.tools.bash), input, branch);
  // Inline-edit path: the Coordinator declared `applied` — it wrote every planned change to disk
  // itself during planning (opencode-style: the agent decides when to delegate; the harness honors "I
  // did it myself"). The branch is checked out (just above), so inline edits landed there directly.
  // Each planned file is phantom-guarded (git status) so a claimed `applied` with nothing on disk
  // blocks rather than an empty commit — the same discipline the fanout path enforces per editor.
  // Summary comes from each entry's `purpose` (the Coordinator's own description); there are no
  // editor texts to harvest.
  // `applied` is what the Coordinator DECLARED; the working tree is what it actually DID, and the two
  // diverge in practice. Measured on a real run: the self-review pass edited every file it planned
  // with its own tools, submitted a manifest without the flag, and the harness fanned out two editors
  // onto work that was already on disk — one of them spent its turn reverting and restoring a file
  // just to re-prove a test it had not written, for a net zero-line diff. When every planned file is
  // already modified, the plan is already executed by definition, and re-running it can only
  // re-derive or damage it.
  const appliedInline =
    manifest.applied ||
    (input.inlineEditsExpected === true &&
      (await everyPlannedFileTouched(init.tools.bash, input, manifest.files, dirtyBefore)));
  if (appliedInline) {
    if (!manifest.applied) {
      harnessProgress(
        `group ${input.group.id}: every planned file is already edited — skipping the editor fanout`,
      );
    }
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
  const outcomes: EditorOutcome[] = await runEditorFanout(init, manifest, input);
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
  // The verify gate's fix pass hands the failing output as a fenced data block (renderVerifyFailure),
  // NOT as trusted task text. Emitted verbatim: it is already source-bounded (VERIFY_TAIL_MAX) and
  // fenced, so re-capping it at MANIFEST_FIELD_MAX would only starve the tail and shear the fence.
  if (input.verifyFailureBlock) {
    lines.push('', input.verifyFailureBlock);
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

const EMPTY_PATHS: ReadonlySet<string> = new Set();

// Parse porcelain output from `git status --porcelain=v1 -z` (NUL-separated). Handles renames/copies
// and quoted paths correctly, unlike the newline format which breaks on special characters and renames.
// A regular change is one status field `XY<space>path`. A rename/copy is a status field naming the
// DESTINATION followed by a BARE field (no `XY ` prefix) naming the source —
// `XY<space><dest><NUL><src><NUL>` (with `-z` git emits destination first, then source). Returns every
// affected path (both dest and src for renames/copies) so `dirtyPaths` builds the full baseline.
// Exported for the unit test of the rename/copy case.
export function parsePorcelainZ(porcelainOutput: string): readonly string[] {
  const fields = porcelainOutput.split('\0').filter((f) => f !== '');
  const paths: string[] = [];

  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry === undefined || entry.length <= 3) {
      // A status field is `XY ` plus at least one path char; anything shorter is malformed — skip it.
      continue;
    }
    // Status is the first 2 chars, a space is the 3rd; the path starts at index 3.
    const status = entry.slice(0, 2);
    const dest = entry.slice(3);
    if (dest !== '') paths.push(dest);
    // A rename (`R`) or copy (`C`) in either the index or work-tree column is followed by a bare
    // source-path field with no `XY ` prefix — consume it whole and skip it so it is not mis-sliced.
    if (status.includes('R') || status.includes('C')) {
      const src = fields[i + 1];
      if (src !== undefined && src !== '') paths.push(src);
      i++;
    }
  }

  return paths;
}

// Paths already dirty in the working tree, as a set. Taken BEFORE planning so the inline-edit
// inference can tell "the Coordinator just wrote this" from "this was already dirty when the task
// started". Never throws — but a status that won't run returns `undefined`, NOT an empty set: an
// empty baseline is the dangerous case, because a file that was inherited-dirty (dirty before AND
// after) would then pass the "not dirty before" test and look newly edited, skipping the fanout on
// work the pass never did. `undefined` disables the inference entirely (see everyPlannedFileTouched).
async function dirtyPaths(
  bash: WorkerTools['bash'],
  checkoutPath: string,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const exec = requireExec(bash);
    const out = await exec(
      {
        command: `git -C ${shQuote(checkoutPath)} --no-optional-locks status --porcelain -z`,
        description: 'snapshot the working tree before planning',
      },
      { toolCallId: `worker-status-pre-${randomUUID()}`, messages: [] },
    );
    if (isAsyncIterable(out) || out.exitCode !== 0) return undefined;
    return new Set(parsePorcelainZ(out.stdout));
  } catch {
    return undefined;
  }
}

// True when EVERY planned file was edited DURING planning — the signature of a Coordinator that did
// the work inline and never declared `applied`. Two conditions, both required:
//
//   - dirty now: the change is really on disk, not merely described;
//   - not dirty before: it is this pass's work, not leftovers the task inherited.
//
// The second is what makes this safe to act on. Dirtiness alone would mean a task that starts with a
// modified file could skip the fanout and commit nothing of its own. And it is all-or-nothing: a
// partially-edited manifest still fans out, so a leaf with real work left is never skipped because a
// sibling's file happened to be finished.
async function everyPlannedFileTouched(
  bash: WorkerTools['bash'],
  input: WorkerInput,
  files: readonly FileManifestEntry[],
  dirtyBefore: ReadonlySet<string> | undefined,
): Promise<boolean> {
  // No trustworthy pre-planning baseline → cannot tell new edits from inherited dirt → do not skip.
  if (dirtyBefore === undefined) return false;
  if (files.length === 0) return false;
  for (const file of files) {
    if (dirtyBefore.has(file.path)) return false;
    if (!(await editorTouchedPath(bash, input.checkoutPath, file.path))) return false;
  }
  return true;
}

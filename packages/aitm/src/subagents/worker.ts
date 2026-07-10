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
  composeSystemPrompt,
  createSubagent,
  formatSubmitIssues,
  runWithSchemaRetry,
} from '@developerz.ai/ai-claude-compat';
import { generateText, stepCountIs, type Tool, type ToolLoopAgent, tool } from 'ai';
import { z } from 'zod';
import type { LoggerLike } from '../logger/logger.ts';
import type { PrGroup, Task } from '../state/schema.ts';
import { prependContextBlock, type SubagentInit } from './factory.ts';

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
});
export type FileManifest = z.infer<typeof FileManifestSchema>;

export type WorkerAgent = ToolLoopAgent<never, WorkerTools>;

export type WorkerInput = {
  group: PrGroup;
  // The specific task this pass focuses on. When set, the manifest prompt and progress entries
  // scope to this single task; when omitted (the CI-fix / orchestrator-as-tool path) the Worker
  // plans across the whole group. The two-phase manifest/editor flow is unchanged either way.
  task?: Task;
  worktreePath: string;
  baseBranch: string;
  styleContents: string;
  rollingContext: string;
  // Optional shell command run in the worktree before staging, so the committed diff matches
  // the project's formatter (LLM output rarely is byte-identical to biome/prettier/gofmt). When
  // unset, no format step runs. See issue #48.
  formatCommand?: string;
  // Optional shell command run in the worktree after the editor fanout and after formatCommand,
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
  | { kind: 'ok'; delivery: WorkerDelivery }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

export const WORKER_SYSTEM_PREFIX = [
  '',
  'You are the Worker. One PR group → a file manifest for a single pull request. You run Phase 1 only.',
  '',
  'Phase 1: survey the real code first — glob/grep to locate, readFile to confirm what exists — then',
  '`submit` a FileManifest: every file to create/modify/delete, each with a purpose, plus a draft',
  'commit subject.',
  '',
  'Phase 2 is out of your hands: the runtime fans the manifest to parallel editors, one per file.',
  'Each editor sees ONLY its path + purpose — never the plan, the group, or the sibling files. So',
  'write each purpose as a self-contained spec: what to change, where, the contract it must meet.',
  'A vague purpose produces a wrong file.',
  '',
  'Tips:',
  '- One responsibility per file; list each path once — parallel editors racing on one path clobber it.',
  "- Don't plan a modify you haven't read.",
  '- draftCommitMessage is a hint the Orchestrator may rewrite; conventional subject, ≤72 chars.',
  '',
  'If earlier conversation was summarized (context compaction), continue the task from that summary —',
  'do not wrap up early, re-plan from scratch, or hand off; resume where the summary leaves off.',
].join('\n');

// Editor subagent prompt — applied to every per-file fanout. Kept here so the Worker
// owns the contract its editors run under.
const EDITOR_SYSTEM_PREFIX = [
  '',
  'You are a per-file editor. You get ONE file path and a purpose — your entire brief; you cannot',
  'see the plan or the other files. Realize it fully, here.',
  '',
  '- create → `writeFile` with the full contents.',
  '- modify → `readFile` first (editing unread content corrupts it), then `editFile` (one exact',
  '  replacement) or `multiEdit` (several, atomic). `writeFile` only for a full rewrite.',
  '- delete → `bash rm -f <path>`.',
  '- dependent shell steps (`mkdir … && generate && test`) → `multiBash` with an ordered `commands`',
  '  array; it stops at the first failure, so you see which step broke.',
  "Independent calls can go in parallel. Match the file style; add nothing the purpose didn't ask for.",
  '',
  "Your first line is returned to the Worker as this file's summary — one line, present tense,",
  'specific: `adds retry+backoff to fetchUser`, not `done`.',
].join('\n');

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
      ...(init.prepareStep ? { prepareStep: init.prepareStep } : {}),
      ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
    },
    30,
  );
  workerInitRegistry.set(agent, init);
  return agent;
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
    const planned = await planAndEdit(agent, init, input);
    if (planned.kind === 'blocked') return { kind: 'blocked', reason: planned.reason };
    if (planned.kind === 'error') return { kind: 'error', error: planned.error };

    // delivery.changes must reflect every committed edit, so a fix pass that touched new files
    // is appended to the first-pass changes (the Orchestrator narrates the PR body off this).
    let changes = planned.changes;
    if (input.verifyCommand) {
      // Verify gate: format + verify, one bounded fix pass, commit only when green. A red diff
      // never reaches the remote when the operator has configured a verify command (issue #122).
      const gated = await commitWithVerify(agent, init, input, branch, planned.draftCommitMessage);
      if (gated.kind === 'blocked') return { kind: 'blocked', reason: gated.reason };
      if (gated.extraChanges.length > 0) changes = [...changes, ...gated.extraChanges];
    } else {
      await commitOnBranch(init.tools.bash, input, branch, planned.draftCommitMessage);
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
    };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

type PlanEditResult =
  | { kind: 'ok'; changes: FileChange[]; draftCommitMessage: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

// Phase 1 + Phase 2 only: plan the file manifest, then fan editors out over it. No verify, no
// commit. Shared by the main pass and the single bounded verify fix pass — because the fix pass
// runs through here (which never verifies), it can never trigger a second fix pass.
async function planAndEdit(
  agent: WorkerAgent,
  init: SubagentInit<WorkerTools>,
  input: WorkerInput,
): Promise<PlanEditResult> {
  const submitted = await planManifest(agent, input);
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
    return { kind: 'blocked', reason: EMPTY_MANIFEST_REASON };
  }
  const changes = await Promise.all(manifest.files.map((file) => runEditor(init, file, input)));
  return { kind: 'ok', changes, draftCommitMessage: manifest.draftCommitMessage };
}

// Gate committing on `verifyCommand`. Branch checkout + format run first (verify must see the
// formatted files); then verify in the worktree. On a non-zero exit: exactly ONE bounded fix pass
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
  await checkoutAndFormat(exec, input, branch);

  let started = Date.now();
  let out = await runVerify(exec, input);
  logVerify(input, out, Date.now() - started, out.exitCode !== 0);

  let extraChanges: FileChange[] = [];
  if (out.exitCode !== 0) {
    // One bounded fix pass. planAndEdit never verifies, so this cannot recurse. Its edits are
    // captured for the delivery; an empty/blocked fix manifest simply makes zero edits, and the
    // re-verify below is still authoritative (per the spec, a still-red gate blocks on the tail).
    const fixed = await planAndEdit(agent, init, {
      ...input,
      task: buildVerifyFixTask(input.group.id, out),
    });
    if (fixed.kind === 'ok') extraChanges = fixed.changes;
    await runFormat(exec, input);
    started = Date.now();
    out = await runVerify(exec, input);
    logVerify(input, out, Date.now() - started, false);
    if (out.exitCode !== 0) {
      return { kind: 'blocked', reason: verifyBlockedReason(input.verifyCommand ?? '', out) };
    }
  }

  await stageAndCommit(exec, input, message);
  return { kind: 'ok', extraChanges };
}

function planManifest(agent: WorkerAgent, input: WorkerInput) {
  // The schema-retry kernel corrects a botched `submit` in-conversation before giving up, so a
  // weak model that mangles the FileManifest once no longer ends the leg. planAndEdit maps the
  // typed failure (no-submission → capability guidance; invalid → error) to its own outcome.
  return runWithSchemaRetry(agent, FileManifestSchema, buildManifestPrompt(input));
}

function buildManifestPrompt(input: WorkerInput): string {
  const lines = [
    `PR group: ${input.group.id} — ${input.group.title}`,
    `Branch: ${input.group.branch ?? `aitm/${input.group.id}`}`,
    `Base branch: ${input.baseBranch}`,
    `Worktree: ${input.worktreePath}`,
    '',
  ];
  if (input.task) {
    lines.push(`Current task [${input.task.complexity}]: ${input.task.text}`);
    if (input.task.subtasks && input.task.subtasks.length > 0) {
      lines.push('Subtasks:', ...input.task.subtasks.map((s) => `  - ${s}`));
    }
  } else {
    lines.push(
      'Tasks in this PR group:',
      ...input.group.tasks.map((task, i) => `  ${i + 1}. ${task.text}`),
    );
  }
  if (input.rollingContext.trim()) {
    lines.push('', 'Rolling context from prior PRs:', input.rollingContext);
  }
  lines.push('', 'Survey the repo, then call submit with the FileManifest.');
  return prependContextBlock(input.contextBlock, lines.join('\n'));
}

async function runEditor(
  init: SubagentInit<WorkerTools>,
  file: FileManifestEntry,
  input: WorkerInput,
): Promise<FileChange> {
  const { text } = await callWithStepTimeout(
    () =>
      generateText({
        model: init.model,
        tools: init.tools,
        system: composeSystemPrompt(input.styleContents, EDITOR_SYSTEM_PREFIX, input.worktreePath),
        prompt: buildEditorPrompt(file, input),
        stopWhen: stepCountIs(12),
        providerOptions: { openai: { parallelToolCalls: true } },
        ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
      }),
    init.timeout,
  );
  const firstLine = text.trim().split('\n')[0];
  const summary = firstLine && firstLine.length > 0 ? firstLine : `${file.kind} ${file.path}`;
  return { path: file.path, kind: file.kind, summary };
}

function buildEditorPrompt(file: FileManifestEntry, input: WorkerInput): string {
  return [
    `Worktree: ${input.worktreePath}`,
    `File: ${file.path}`,
    `Change kind: ${file.kind}`,
    `Purpose: ${file.purpose}`,
    '',
    'Make the change. Reply with a one-line summary.',
  ].join('\n');
}

async function commitOnBranch(
  bash: Tool<BashInput, BashOutput>,
  input: WorkerInput,
  branch: string,
  message: string,
): Promise<void> {
  const exec = requireExec(bash);
  await checkoutAndFormat(exec, input, branch);
  await stageAndCommit(exec, input, message);
}

// Branch setup + format — the pre-staging steps shared by the plain commit path and the verify
// gate (which slots verify + a fix pass between this and stageAndCommit).
async function checkoutAndFormat(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
  branch: string,
): Promise<void> {
  await runBash(exec, `git -C ${shQuote(input.worktreePath)} checkout -B ${shQuote(branch)}`);
  await runFormat(exec, input);
}

// Stage (excluding aitm's own state dir) + commit — the post-verify steps shared by both paths.
// Excluding `.ai-task-master/` keeps our state.json/goal out of the target-repo commit even when
// the target repo does not gitignore it; the `:!` pathspec leaves its tracked files untouched.
async function stageAndCommit(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
  message: string,
): Promise<void> {
  const wt = shQuote(input.worktreePath);
  await runBash(exec, `git -C ${wt} add -A -- ${shQuote(':!.ai-task-master')}`);
  await runBash(exec, `git -C ${wt} commit -m ${shQuote(message)}`);
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
  await runBash(exec, `cd ${shQuote(input.worktreePath)} && ${input.formatCommand}`);
}

// Run the verify command in the worktree and return its raw outcome. Unlike runBash it never
// throws on a non-zero exit — a failing verify is a handled outcome the gate reacts to, so it
// reads exitCode/stdout/stderr off BashOutput directly. Carries the hard-ceiling timeout so a
// real test suite isn't cut off at the bash tool's 60s default (issue #122).
async function runVerify(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  input: WorkerInput,
): Promise<BashOutput> {
  const command = `cd ${shQuote(input.worktreePath)} && ${input.verifyCommand}`;
  const out = await exec(
    { command, description: 'run the configured verify command', timeoutMs: VERIFY_TIMEOUT_MS },
    { toolCallId: `worker-verify-${Date.now()}`, messages: [] },
  );
  if (isAsyncIterable(out)) {
    throw new Error('bash tool returned an async iterable; expected a single result');
  }
  return out;
}

function logVerify(
  input: WorkerInput,
  out: BashOutput,
  durationMs: number,
  fixPassFollowed: boolean,
): void {
  input.logger?.info('worker: verify', {
    command: input.verifyCommand,
    exitCode: out.exitCode,
    durationMs,
    fixPassFollowed,
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

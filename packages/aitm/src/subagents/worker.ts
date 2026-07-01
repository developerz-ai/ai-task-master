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
  composeSystemPrompt,
  createSubagent,
  submittedOutput,
} from '@developerz.ai/ai-claude-compat';
import { generateText, stepCountIs, type Tool, type ToolLoopAgent, tool } from 'ai';
import { z } from 'zod';
import type { PrGroup, Task } from '../state/schema.ts';
import type { SubagentInit } from './factory.ts';

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
  'You are the Worker subagent. You receive one PR group: a coherent batch of tasks that',
  'land in a single pull request on a dedicated branch. Work in two phases.',
  '',
  'Phase 1 — manifest. Use your read-only tools (readFile with optional offset/limit, grep,',
  'glob) to ground yourself in the existing code, then call the `submit` tool with a FileManifest',
  'listing every file to create/modify/delete plus a one-line draft commit message. Do not edit yet.',
  '',
  'Phase 2 — edits. Each manifest entry is handed to a dedicated editor subagent in',
  'parallel by the runtime; you do not execute Phase 2 yourself.',
  '',
  'Rules:',
  '- Stay inside the worktree provided. No work outside the repo.',
  '- One responsibility per file. If a file has multiple unrelated edits, split it.',
  '- draftCommitMessage is a hint to the Orchestrator; keep the subject under 72 chars.',
  '- When the manifest is complete, call `submit` once with the FileManifest (matching the schema).',
].join('\n');

// Editor subagent prompt — applied to every per-file fanout. Kept here so the Worker
// owns the contract its editors run under.
const EDITOR_SYSTEM_PREFIX = [
  '',
  'You are a per-file editor subagent. You receive one file path and a purpose.',
  '- To CREATE a file, emit its full contents via `writeFile`.',
  '- To MODIFY an existing file, `readFile` it first, then prefer `editFile` (one exact string',
  '  replacement) or `multiEdit` (several replacements applied atomically). Use `writeFile` only',
  '  for a full rewrite.',
  '- To DELETE a file, use `bash` with `rm -f <path>`.',
  '- For a dependent sequence of shell steps (e.g. `mkdir … && generate && test`), prefer',
  '  `multiBash` with an ordered `commands` array — it stops at the first failure, so you',
  '  see exactly which step broke without chaining `&&` by hand.',
  'You may issue multiple tool calls in parallel.',
  '',
  "IMPORTANT: your final assistant message is returned to the outer Worker as this file's",
  'summary. Keep it to one line, present-tense, and specific.',
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
    },
    30,
  );
  workerInitRegistry.set(agent, init);
  return agent;
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
    const manifest = await planManifest(agent, input);
    if (manifest.files.length === 0) {
      // A degenerate (empty) manifest almost always means the configured `coding` model wasn't
      // strong enough to plan this PR group into a structured FileManifest — weak/cheap models
      // routinely return zero files here. Surface that as actionable guidance instead of a bare
      // block, so the user reaches for a more capable model rather than re-running blindly.
      return {
        kind: 'blocked',
        reason:
          'The Worker returned an empty file manifest — the configured coding model produced no files to change for this PR group. This usually means the model is not capable enough to plan the work; try a more capable coding model (set `models.coding` in .ai-task-master/config.json or pass a stronger --model).',
      };
    }
    const changes = await Promise.all(manifest.files.map((file) => runEditor(init, file, input)));
    await commitOnBranch(init.tools.bash, input, branch, manifest.draftCommitMessage);
    return {
      kind: 'ok',
      delivery: {
        branch,
        draftCommitMessage: manifest.draftCommitMessage,
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

async function planManifest(agent: WorkerAgent, input: WorkerInput): Promise<FileManifest> {
  const result = await agent.generate({ prompt: buildManifestPrompt(input) });
  // No submission (e.g. step budget exhausted) → empty manifest; runWorker maps that to a
  // "blocked" with model-capability guidance, same as a degenerate zero-file manifest.
  return submittedOutput(result, FileManifestSchema) ?? { files: [], draftCommitMessage: '' };
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
  return lines.join('\n');
}

async function runEditor(
  init: SubagentInit<WorkerTools>,
  file: FileManifestEntry,
  input: WorkerInput,
): Promise<FileChange> {
  const { text } = await generateText({
    model: init.model,
    tools: init.tools,
    system: composeSystemPrompt(input.styleContents, EDITOR_SYSTEM_PREFIX, input.worktreePath),
    prompt: buildEditorPrompt(file, input),
    stopWhen: stepCountIs(12),
    providerOptions: { openai: { parallelToolCalls: true } },
  });
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
  const exec = bash.execute;
  if (typeof exec !== 'function') {
    throw new Error('bash tool is missing an execute function');
  }
  const wt = shQuote(input.worktreePath);
  await runBash(exec, `git -C ${wt} checkout -B ${shQuote(branch)}`);
  // Format BEFORE staging so the committed diff matches the project's formatter — LLM output
  // is rarely byte-identical to biome/prettier/gofmt, and a format-gated CI would otherwise
  // reject an otherwise-correct PR (issue #48). Run in the worktree; a non-zero exit (e.g.
  // unfixable lint errors) surfaces as a worker error rather than a silent CI failure later.
  if (input.formatCommand) {
    await runBash(exec, `cd ${wt} && ${input.formatCommand}`);
  }
  // Exclude aitm's own state dir: if `.ai-task-master/` sits in the worktree and the target
  // repo does not gitignore it, `git add -A` would otherwise commit our state.json/goal into
  // the PR. The `:!` pathspec keeps the target repo's tracked files (incl. its .gitignore)
  // untouched while guaranteeing the state dir is never staged.
  await runBash(exec, `git -C ${wt} add -A -- ${shQuote(':!.ai-task-master')}`);
  await runBash(exec, `git -C ${wt} commit -m ${shQuote(message)}`);
}

async function runBash(
  exec: NonNullable<Tool<BashInput, BashOutput>['execute']>,
  command: string,
): Promise<void> {
  const out = await exec({ command }, { toolCallId: `worker-bash-${Date.now()}`, messages: [] });
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

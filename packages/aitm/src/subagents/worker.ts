// docs/subagents.md (Worker row), docs/task-groups.md, docs/commands/start.md
// One PR group: produce file changes + commits on a dedicated branch. Does NOT open the PR
// and does NOT finalize the commit message — those belong to the Orchestrator (more reliable
// at composing global-context narration: PR title, body, squash commit message).
//
// Strategy for *really big PRs* (the explicit design goal) — two layers of parallelism:
//
//   Layer A (outer, across files): plan a file manifest via Output.object() that lists every
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
  MultiEditInput,
  MultiEditOutput,
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
} from '@developerz-ai/ai-claude-compat';
import { composeSystemPrompt, createSubagent } from '@developerz-ai/ai-claude-compat';
import {
  type DeepPartial,
  generateText,
  Output,
  stepCountIs,
  type Tool,
  type ToolLoopAgent,
} from 'ai';
import { z } from 'zod';
import type { PrGroup } from '../state/schema.ts';
import type { SubagentInit } from './factory.ts';

// The Claude-Code-style tool surface (from @developerz-ai/ai-claude-compat) the Worker drives:
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

type WorkerOutput = Output.Output<FileManifest, DeepPartial<FileManifest>, never>;

export type WorkerAgent = ToolLoopAgent<never, WorkerTools, WorkerOutput>;

export type WorkerInput = {
  group: PrGroup;
  worktreePath: string;
  baseBranch: string;
  styleContents: string;
  rollingContext: string;
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
  'glob) to ground yourself in the existing code, then emit a FileManifest JSON listing every',
  'file to create/modify/delete plus a one-line draft commit message. Do not edit yet.',
  '',
  'Phase 2 — edits. Each manifest entry is handed to a dedicated editor subagent in',
  'parallel by the runtime; you do not execute Phase 2 yourself.',
  '',
  'Rules:',
  '- Stay inside the worktree provided. No work outside the repo.',
  '- One responsibility per file. If a file has multiple unrelated edits, split it.',
  '- draftCommitMessage is a hint to the Orchestrator; keep the subject under 72 chars.',
  '- Return the FileManifest JSON exactly matching the schema.',
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
  'You may issue multiple tool calls in parallel.',
  '',
  "IMPORTANT: your final assistant message is returned to the outer Worker as this file's",
  'summary. Keep it to one line, present-tense, and specific.',
].join('\n');

// Module-private link from a Worker agent back to its init, so runWorker can spawn editor
// sub-agents with the same model + tool handles without exposing them on the public surface.
const workerInitRegistry = new WeakMap<WorkerAgent, SubagentInit<WorkerTools>>();

export function createWorkerAgent(init: SubagentInit<WorkerTools>): WorkerAgent {
  const agent = createSubagent<WorkerTools, WorkerOutput>(
    {
      model: init.model,
      tools: init.tools,
      systemPrompt: init.systemPrompt,
      output: Output.object({ schema: FileManifestSchema, name: 'FileManifest' }),
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
      return { kind: 'blocked', reason: 'worker produced an empty file manifest' };
    }
    const changes = await Promise.all(manifest.files.map((file) => runEditor(init, file, input)));
    await commitOnBranch(init.tools.bash, input, branch, manifest.draftCommitMessage);
    return {
      kind: 'ok',
      delivery: {
        branch,
        draftCommitMessage: manifest.draftCommitMessage,
        changes,
        progressEntries: input.group.tasks.map((task) => `- ${task}`),
      },
    };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

async function planManifest(agent: WorkerAgent, input: WorkerInput): Promise<FileManifest> {
  const result = await agent.generate({ prompt: buildManifestPrompt(input) });
  return result.experimental_output;
}

function buildManifestPrompt(input: WorkerInput): string {
  const lines = [
    `PR group: ${input.group.id} — ${input.group.title}`,
    `Branch: ${input.group.branch ?? `aitm/${input.group.id}`}`,
    `Base branch: ${input.baseBranch}`,
    `Worktree: ${input.worktreePath}`,
    '',
    'Tasks in this PR group:',
    ...input.group.tasks.map((task, i) => `  ${i + 1}. ${task}`),
  ];
  if (input.rollingContext.trim()) {
    lines.push('', 'Rolling context from prior PRs:', input.rollingContext);
  }
  lines.push('', 'Survey the repo, then emit the FileManifest JSON.');
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
  await runBash(exec, `git -C ${wt} add -A`);
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

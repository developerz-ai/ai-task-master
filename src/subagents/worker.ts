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
//   3. Stage + commit on the group branch with a draft commit message. Orchestrator may rewrite it.
//   4. toModelOutput compresses each editor's full transcript to a one-line summary before it goes
//      back to the Worker's loop — keeps the Worker context coherent on 1000+ line PRs.
//   5. Compactor monitors live token usage vs ModelLimitsRegistry.contextLength; when it crosses
//      the threshold, prepareStep swaps in a compacted message prefix.
//
// SDK references:
//   chunk-09.md §"Subagents" (toModelOutput pattern)
//   chunk-09.md §"Loop Control" §"Prepare Step" (swap tools/model + messages per step)
//   chunk-02.md §"Tool Calling" (parallelToolCalls)
//   chunk-04.md §"ToolLoopAgent" (agent class)

import type { ToolLoopAgent } from 'ai';
import type { PrGroup } from '../state/schema.ts';
import type { SubagentInit } from './factory.ts';

export type WorkerTools = {
  readFile: unknown;
  writeFile: unknown;
  bash: unknown;
};

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

export function createWorkerAgent(_init: SubagentInit): ToolLoopAgent<WorkerTools> {
  throw new Error('not implemented');
}

export async function runWorker(
  _agent: ToolLoopAgent<WorkerTools>,
  _input: WorkerInput,
): Promise<WorkerResult> {
  throw new Error('not implemented');
}

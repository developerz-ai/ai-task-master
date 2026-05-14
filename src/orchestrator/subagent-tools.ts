// Wrap each subagent as a tool consumable by the Orchestrator agent.
// Pattern verbatim from docs/vendor/ai-sdk/chunk-09.md §"Basic Subagent Without Streaming" and
// §"Controlling What the Model Sees" — toModelOutput keeps the Orchestrator context lean.
//
// Each wrapper:
//   - inputSchema  — Zod schema (the boundary type for the subagent call)
//   - execute      — calls subagent.generate({ prompt, abortSignal })
//   - toModelOutput — collapses full transcript to a short summary before the model sees it

import type { Tool } from 'ai';
import type { Credentials } from '../credentials/credentials.ts';

export type SubagentToolDeps = {
  credentials: Credentials;
  styleContents: string;
  rollingContext: string;
};

export function makePlannerTool(_deps: SubagentToolDeps): Tool {
  throw new Error('not implemented');
}

export function makeWorkerTool(_deps: SubagentToolDeps): Tool {
  throw new Error('not implemented');
}

export function makeReviewerTool(_deps: SubagentToolDeps): Tool {
  throw new Error('not implemented');
}

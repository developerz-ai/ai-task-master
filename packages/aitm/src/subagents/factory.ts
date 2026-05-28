// docs/subagents.md §"SRP + tested" — every subagent is a pure factory:
//   (model, tools, systemPrompt) -> Agent
// SDK reference: docs/vendor/ai-sdk/chunk-04.md §"ToolLoopAgent" (note: CLAUDE.md
// still says experimental_Agent — that is the legacy AI SDK 5 name; v6 ships ToolLoopAgent).
//
// The ToolLoopAgent wrapper (`createSubagent`) and the system-prompt composer
// (`composeSystemPrompt`) now live in @developerz.ai/ai-claude-compat; the concrete factories
// (planner.ts/worker.ts/reviewer.ts) call createSubagent with their own tools + output type.

import type { LanguageModel, ToolSet } from 'ai';

export type SubagentInit<TTools extends ToolSet = ToolSet> = {
  model: LanguageModel;
  tools: TTools;
  systemPrompt: string;
  // Stop conditions — docs/vendor/ai-sdk/chunk-09.md §"Loop Control".
  maxSteps?: number;
};

// Concrete factory implementations live next to each subagent: planner.ts, worker.ts, reviewer.ts.
export type SubagentFactory<TInit, TAgent> = (init: TInit) => TAgent;

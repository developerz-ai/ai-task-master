// docs/subagents.md §"SRP + tested" — every subagent is a pure factory:
//   (model, tools, systemPrompt) -> Agent
// SDK reference: docs/vendor/ai-sdk/chunk-04.md §"ToolLoopAgent" (note: CLAUDE.md
// still says experimental_Agent — that is the legacy AI SDK 5 name; v6 ships ToolLoopAgent).
//
// The ToolLoopAgent wrapper (`createSubagent`) and the system-prompt composer
// (`composeSystemPrompt`) now live in @developerz.ai/ai-claude-compat; the concrete factories
// (planner.ts/worker.ts/reviewer.ts) call createSubagent with their own tools + output type.

import type { LanguageModel, ToolLoopAgentSettings, ToolSet } from 'ai';

export type SubagentInit<TTools extends ToolSet = ToolSet> = {
  model: LanguageModel;
  tools: TTools;
  systemPrompt: string;
  // Stop conditions — docs/vendor/ai-sdk/chunk-09.md §"Loop Control".
  maxSteps?: number;
  // Optional per-step hook, passed through to createSubagent. aitm builds one from a Compactor to
  // summarize-and-continue when context fills (issue #102); unset → no compaction. Typed by
  // indexing the SDK's own settings (matches createSubagent's field; see the note there).
  prepareStep?: ToolLoopAgentSettings<never, TTools>['prepareStep'];
};

// Concrete factory implementations live next to each subagent: planner.ts, worker.ts, reviewer.ts.
export type SubagentFactory<TInit, TAgent> = (init: TInit) => TAgent;

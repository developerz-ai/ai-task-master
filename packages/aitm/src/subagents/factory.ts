// docs/subagents.md §"SRP + tested" — every subagent is a pure factory:
//   (model, tools, systemPrompt) -> Agent
// SDK reference: docs/vendor/ai-sdk/chunk-04.md §"ToolLoopAgent" (note: CLAUDE.md
// still says experimental_Agent — that is the legacy AI SDK 5 name; v6 ships ToolLoopAgent).
//
// The ToolLoopAgent wrapper (`createSubagent`) and the system-prompt composer
// (`composeSystemPrompt`) now live in @developerz.ai/ai-claude-compat; the concrete factories
// (planner.ts/worker.ts/reviewer.ts) call createSubagent with their own tools + output type.

import type { LanguageModel, TimeoutConfiguration, ToolLoopAgentSettings, ToolSet } from 'ai';

// Default per-step LLM request deadline (issue #129). The bound covers one provider HTTP call plus
// that step's tool executions, and a single legitimate Worker step may run a bash call at the tool's
// own 600s ceiling (MAX_BASH_TIMEOUT_MS) plus a slow high-effort completion — so the default clears
// 600s comfortably. Config `llmStepTimeoutMs` overrides it; the schema floor is 1000ms.
export const DEFAULT_LLM_STEP_TIMEOUT_MS = 900_000;

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
  // Per-step LLM request deadline, forwarded to createSubagent and armed at generate time (issue
  // #129). Unset → no deadline. aitm threads `{ stepMs: llmStepTimeoutMs }` from resolved config.
  timeout?: TimeoutConfiguration;
};

// Concrete factory implementations live next to each subagent: planner.ts, worker.ts, reviewer.ts.
export type SubagentFactory<TInit, TAgent> = (init: TInit) => TAgent;

// Prepend an optional harness context block (a `<system-reminder>` envelope from
// compat's contextReminder) to a subagent's first user message, separated by a blank line. Unset →
// the prompt is returned unchanged. Shared by the planner/worker/reviewer prompt builders (#106).
export function prependContextBlock(contextBlock: string | undefined, prompt: string): string {
  return contextBlock ? `${contextBlock}\n\n${prompt}` : prompt;
}

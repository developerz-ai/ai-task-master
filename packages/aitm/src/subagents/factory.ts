// docs/subagents.md §"SRP + tested" — every subagent is a pure factory:
//   (model, tools, systemPrompt) -> Agent
// SDK reference: docs/vendor/ai-sdk/chunk-04.md §"ToolLoopAgent" (note: CLAUDE.md
// still says experimental_Agent — that is the legacy AI SDK 5 name; v6 ships ToolLoopAgent).
//
// The ToolLoopAgent wrapper (`createSubagent`) and the system-prompt composer
// (`composeSystemPrompt`) now live in @developerz.ai/ai-claude-compat; the concrete factories
// (planner.ts/worker.ts/reviewer.ts) call createSubagent with their own tools + output type.

import type {
  LanguageModel,
  LanguageModelUsage,
  TimeoutConfiguration,
  ToolLoopAgentSettings,
  ToolSet,
} from 'ai';

// A subagent-usage sink (issue #114). Fired once per generate call with the result's `totalUsage`
// (all steps) and `response.modelId`. Fire-and-forget: a recording error must never break the run,
// so the accumulation side (UsageTracker.record) swallows and this stays a plain void callback.
export type OnUsage = (usage: LanguageModelUsage, modelId: string | undefined) => void;

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
  // Provider-specific options forwarded to createSubagent's ToolLoopAgent construction (issue #112).
  // aitm rides OpenRouter server tools here (e.g. web_search: `{ openrouter: { tools: [...] } }`).
  // Unset → none. The Worker's editor fanout reads the same field to merge onto its generateText.
  providerOptions?: ToolLoopAgentSettings<never, TTools>['providerOptions'];
  // Per-call token-usage sink (issue #114). The runners read it from this init to record each
  // generate's totalUsage; unset → no accounting. Fire-and-forget, never breaks the run.
  onUsage?: OnUsage;
};

// Concrete factory implementations live next to each subagent: planner.ts, worker.ts, reviewer.ts.
export type SubagentFactory<TInit, TAgent> = (init: TInit) => TAgent;

// Prepend an optional harness context block (a `<system-reminder>` envelope from
// compat's contextReminder) to a subagent's first user message, separated by a blank line. Unset →
// the prompt is returned unchanged. Shared by the planner/worker/reviewer prompt builders (#106).
export function prependContextBlock(contextBlock: string | undefined, prompt: string): string {
  return contextBlock ? `${contextBlock}\n\n${prompt}` : prompt;
}

// Feed a generate result's total usage + resolved model id to an optional sink (issue #114). For the
// direct generateText / agent.generate call sites (worker editor + manifest, orchestrator, style
// distiller); the schema-retry path meters inside compat. Fire-and-forget — never breaks the run.
export function reportUsage(
  onUsage: OnUsage | undefined,
  result: { totalUsage: LanguageModelUsage; response: { modelId: string } },
): void {
  if (!onUsage) return;
  try {
    onUsage(result.totalUsage, result.response.modelId);
  } catch {
    // observability must never break the run
  }
}

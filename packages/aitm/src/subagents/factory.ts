// docs/subagents.md §"SRP + tested" — every subagent is a pure factory:
//   (model, tools, systemPrompt) -> Agent
// SDK reference: docs/vendor/ai-sdk/chunk-04.md §"ToolLoopAgent" (note: CLAUDE.md
// still says experimental_Agent — that is the legacy AI SDK 5 name; v6 ships ToolLoopAgent).
//
// The ToolLoopAgent wrapper (`createSubagent`) and the system-prompt composer
// (`composeSystemPrompt`) now live in @developerz.ai/ai-claude-compat; the concrete factories
// (planner.ts/worker.ts/reviewer.ts) call createSubagent with their own tools + output type.

import type {
  RetryOptions,
  StreamWatchdogConfig,
  SubagentConfig,
  SubagentStreamSink,
} from '@developerz.ai/ai-claude-compat';
import type {
  LanguageModel,
  LanguageModelUsage,
  ProviderMetadata,
  TimeoutConfiguration,
  ToolLoopAgentSettings,
  ToolSet,
} from 'ai';

// A subagent-usage sink (issue #114). Fired once per generate call with the result's `totalUsage`
// (all steps), `response.modelId`, and the result's `providerMetadata` (issue #114 amendment, slice
// 04b) — the channel a provider-reported `cache_discount`/cache-write rides beyond what
// `LanguageModelUsage` carries. Fire-and-forget: a recording error must never break the run, so the
// accumulation side (UsageTracker.record) swallows and this stays a plain void callback.
export type OnUsage = (
  usage: LanguageModelUsage,
  modelId: string | undefined,
  providerMetadata?: ProviderMetadata,
) => void;

// Default per-step LLM request deadline (issue #129). The bound covers one provider HTTP call plus
// that step's tool executions, and a single legitimate Worker step may run a bash call at the tool's
// own 600s ceiling (MAX_BASH_TIMEOUT_MS) plus a slow high-effort completion — so the default clears
// 600s comfortably. Config `llmStepTimeoutMs` overrides it; the schema floor is 1000ms.
export const DEFAULT_LLM_STEP_TIMEOUT_MS = 900_000;

// Runaway backstop for a subagent's tool loop — NOT a work budget. Every subagent terminates when it
// calls `submit` (`hasToolCall(SUBMIT_TOOL_NAME)` in createSubagent's stopWhen), so this cap only
// fires for a pathological agent that never submits. The old per-role caps (12–30) were low enough to
// cut real work off mid-task before it could submit; autocompaction now bounds CONTEXT, so the step
// count no longer needs to, and quality comes first — an agent runs until it is actually done. Set far
// above any real task (a legitimate single-task loop is tens of steps, not hundreds) so it never binds
// in practice while still stopping an infinite loop from burning tokens without end. The per-step
// wall-clock deadline (DEFAULT_LLM_STEP_TIMEOUT_MS) is the orthogonal per-step guard and is unaffected.
export const AGENT_STEP_BACKSTOP = 1000;

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
  // Agent-wide per-step callback forwarded to createSubagent (issue #108). aitm appends each step to
  // a persisted transcript here. Unset → not registered, behavior unchanged.
  onStepFinish?: ToolLoopAgentSettings<never, TTools>['onStepFinish'];
  // Per-step callback FACTORY for the Worker's parallel editor fanout ONLY (silent-run fix; per-editor
  // labels, issue #131). Editors can't share one `onStepFinish` instance: the transcript recorder
  // slices cumulative response messages (#175), which interleaved parallel editor conversations would
  // corrupt. `editorTag` is the basename-or-directory label runEditor derives for its leaf (e.g.
  // `login.ts` or `auth`), so the caller's stream label names WHICH editor is working, not just that
  // an editor is. Handlers built here must read only per-step fields (e.g. the progress stream).
  // Consumed by worker.ts runEditor; unset → editors stay silent.
  onEditorStepFinish?: (editorTag: string) => ToolLoopAgentSettings<never, TTools>['onStepFinish'];
  // Forwarded to createSubagent (slice 01b) so a caller can surface each LLM-call retry (rate limit,
  // transient 5xx) instead of the run going silent through a whole backoff window. Unset → no sink.
  onRetry?: RetryOptions['onRetry'];
  // Live-streaming sink (slice 07), forwarded to createSubagent. Set only when config `streaming` is
  // true — the adapter wires a line-buffered renderer (step-progress.ts createLiveStreamRenderer) so
  // text and tool-call lines print as the model streams them instead of after the step finishes.
  // Unset → generate stays on the non-streaming path, byte-identical to today.
  onStream?: SubagentStreamSink;
  // Overrides for the streaming stall watchdog, forwarded to createSubagent. Unset → production
  // defaults (120s inactivity / 30s grace). Only consulted when onStream is set.
  streamWatchdog?: StreamWatchdogConfig;
  // Run-scoped cancellation handle (the CLI's SIGINT/SIGTERM controller, threaded from
  // RunLoopInput.signal). Forwarded to createSubagent, which applies it to every generate the agent
  // makes — including the ones the schema-retry kernel drives itself — so an abort tears the
  // in-flight LLM request down instead of the run waiting the generation out. Unset → no signal.
  signal?: AbortSignal;
};

// The optional half of a SubagentInit, shaped for createSubagent. One helper so planner/worker/
// reviewer forward the SAME set: each used to hand-roll this spread and quietly dropped fields the
// others forwarded (planner: prepareStep + providerOptions; reviewer: providerOptions), so a caller
// setting one got silence rather than an error. Conditional spreads preserve key-absence under
// exactOptionalPropertyTypes — an unset field must never override a createSubagent default.
export function forwardInit<TTools extends ToolSet>(
  init: SubagentInit<TTools>,
): Omit<SubagentConfig<TTools>, 'model' | 'tools' | 'systemPrompt' | 'submit'> {
  return {
    ...(init.maxSteps !== undefined ? { maxSteps: init.maxSteps } : {}),
    ...(init.prepareStep ? { prepareStep: init.prepareStep } : {}),
    ...(init.timeout !== undefined ? { timeout: init.timeout } : {}),
    ...(init.providerOptions !== undefined ? { providerOptions: init.providerOptions } : {}),
    ...(init.onStepFinish ? { onStepFinish: init.onStepFinish } : {}),
    ...(init.onRetry ? { onRetry: init.onRetry } : {}),
    ...(init.onStream ? { onStream: init.onStream } : {}),
    ...(init.streamWatchdog ? { streamWatchdog: init.streamWatchdog } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  };
}

// Concrete factory implementations live next to each subagent: planner.ts, worker.ts, reviewer.ts.
export type SubagentFactory<TInit, TAgent> = (init: TInit) => TAgent;

// Prepend an optional harness context block (a `<system-reminder>` envelope from
// compat's contextReminder) to a subagent's first user message, separated by a blank line. Unset →
// the prompt is returned unchanged. Shared by the planner/worker/reviewer prompt builders (#106).
export function prependContextBlock(contextBlock: string | undefined, prompt: string): string {
  return contextBlock ? `${contextBlock}\n\n${prompt}` : prompt;
}

// Append an optional TRAILING `<system-reminder>` block (e.g. the run's Step N/M position) to the END
// of a subagent's first user message, separated by a blank line. Unset/empty → the prompt is returned
// unchanged. The companion to prependContextBlock: the LEADING block stays byte-stable so the provider's
// prompt-cache prefix holds; this trailing block carries the per-call volatile bits so they sit AFTER
// the cached prefix (slice 04 §4). Shared by the planner/worker/reviewer prompt builders.
export function appendReminderBlock(prompt: string, trailingBlock: string | undefined): string {
  return trailingBlock ? `${prompt}\n\n${trailingBlock}` : prompt;
}

// Feed a generate result's total usage + resolved model id + provider metadata to an optional sink
// (issue #114, slice 04b). For the direct generateText / agent.generate call sites (worker editor +
// manifest, orchestrator, style distiller); the schema-retry path meters inside compat.
// Fire-and-forget — never breaks the run.
export function reportUsage(
  onUsage: OnUsage | undefined,
  result: {
    totalUsage: LanguageModelUsage;
    response: { modelId: string };
    providerMetadata?: ProviderMetadata | undefined;
  },
): void {
  if (!onUsage) return;
  try {
    onUsage(result.totalUsage, result.response.modelId, result.providerMetadata);
  } catch {
    // observability must never break the run
  }
}

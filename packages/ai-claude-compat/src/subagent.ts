// Provider-agnostic subagent scaffolding for the Vercel AI SDK: compose a system prompt with an
// <env> block, and wrap the `ToolLoopAgent` construction (the subagents-as-tools pattern) behind
// a single factory so callers don't repeat the model/tools/instructions/stopWhen boilerplate.
//
// Structured output is delivered via a terminal `submit` tool (tool/function calling), NOT via
// `Output.object` (which serializes to `response_format: json_schema`). Some OpenAI-compatible
// providers — e.g. z.ai GLM — ignore `response_format` and return prose, breaking `Output.object`.
// Every tool-calling provider (z.ai, Claude/OpenRouter, OpenAI) supports function calls, so the
// submit-tool path is provider-agnostic while keeping the Zod schema as the function's contract.

import {
  hasToolCall,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  NoOutputGeneratedError,
  type ProviderMetadata,
  type StreamTextResult,
  stepCountIs,
  type TimeoutConfiguration,
  type Tool,
  ToolLoopAgent,
  type ToolLoopAgentSettings,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import { detectGitRepo, type EnvInfo, envBlock } from './env-block.ts';
import { type PromptBlock, renderPromptBlocks } from './prompt-blocks.ts';

// The tool a subagent calls to deliver its final structured result.
export const SUBMIT_TOOL_NAME = 'submit';

// Build a subagent system prompt. Two shapes (issue #105):
//
//   composeSystemPrompt(blocks)                 — the ordered prompt-block pipeline: cross-cutting
//                                                 contracts + role/style/env blocks render in one
//                                                 canonical order (see prompt-blocks.ts).
//   composeSystemPrompt(style, rolePrefix, env) — the legacy 3-arg concatenation, kept byte-identical
//                                                 so remaining callers migrate incrementally.
//
// The <env> block gives the model the worktree cwd, platform, runtime, and date; the cwd is
// per-worktree, so the prompt is composed at the wiring site rather than baked into a static prefix.
export function composeSystemPrompt(blocks: readonly PromptBlock[]): string;
export function composeSystemPrompt(
  style: string,
  rolePrefix: string,
  env: string | EnvInfo,
): string;
export function composeSystemPrompt(
  styleOrBlocks: readonly PromptBlock[] | string,
  rolePrefix = '',
  env: string | EnvInfo = '',
): string {
  if (typeof styleOrBlocks !== 'string') return renderPromptBlocks(styleOrBlocks);
  const info: EnvInfo = typeof env === 'string' ? { cwd: env } : env;
  // Detect the git flag rather than asserting it — the string shorthand (every production call site)
  // and a full EnvInfo that leaves isGitRepo unset both resolve it from the cwd (issue #116).
  const resolved: EnvInfo =
    info.isGitRepo === undefined ? { ...info, isGitRepo: detectGitRepo(info.cwd) } : info;
  return `${styleOrBlocks}${rolePrefix}\n${envBlock(resolved)}`;
}

// A live event forwarded from a streamed generation (slice 07). Two kinds mirror what a live renderer
// consumes: incremental assistant text, and each tool call as it is issued (before its result). Kept
// deliberately minimal and provider-agnostic — reasoning and tool-input deltas are intentionally not
// forwarded yet; a downstream renderer buffers text to whole lines.
export type SubagentStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string; input: unknown };

// Sink for streamed events. Invoked in-loop as chunks arrive; a throw is swallowed at the call site so
// a broken sink can never abort — or, through the retry kernel, re-run — a generation.
export type SubagentStreamSink = (event: SubagentStreamEvent) => void;

// --- streaming stall watchdog (slice 07) ---
//
// A live generation can go silent two ways, and each is handled differently. The dividing line is the
// terminal `submit` tool-call: once the model issues it the coding step's answer is in — its tools ran
// and a PR may already exist — even though the SDK only emits the top-level `finish` part (and settles
// the result promises) once the underlying stream actually CLOSES.
//   • Before submit: a provider that stops emitting is a stall. After `inactivityMs` of silence the
//     stream is aborted and re-run ONCE — no answer was produced, so a fresh attempt is safe (the same
//     guarantee the retry kernel already gives generateText).
//   • After submit: the stream is given `graceMs` to close. If it does, the completed result is
//     returned. If it doesn't, the run is a hard StreamStallError — NEVER re-run, since replaying a
//     finished coding step would duplicate its side effects (a duplicate-PR hazard). This split into
//     two regimes, rather than one shared deadline, is the whole point of the watchdog.
//
// Omitting `streamWatchdog` on SubagentConfig → these production defaults (120s / 30s, real timers).
export const STREAM_INACTIVITY_MS = 120_000;
export const STREAM_GRACE_MS = 30_000;
// A mid-stream stall is retried exactly once before it becomes a hard StreamStallError.
export const MAX_STREAM_STALL_RETRIES = 1;

// A cancelable one-shot timer, injected so tests drive the watchdog deterministically without real
// wall-clock waits. `expired` resolves after the window unless `cancel` runs first.
export type StreamTimer = { expired: Promise<void>; cancel: () => void };
export type StreamTimerFactory = (ms: number) => StreamTimer;

// Caller overrides for the stall watchdog — every field optional, each unset one falling back to the
// production default. Policy-free passthrough on SubagentConfig: aitm may tune the windows; tests
// inject `timer`.
export type StreamWatchdogConfig = {
  inactivityMs?: number;
  graceMs?: number;
  timer?: StreamTimerFactory;
};

// The resolved watchdog the consumer runs with — every field settled from config-or-default.
export type StreamWatchdog = {
  inactivityMs: number;
  graceMs: number;
  timer: StreamTimerFactory;
};

// How a watched stream ended: cleanly drained, stalled mid-stream (caller retries once), or stalled
// during the post-finish grace (caller settles — never a retry).
export type StreamWatchdogOutcome = 'drained' | 'stalled-active' | 'stalled-grace';

// A streamed generation went silent and the single mid-stream retry did not recover it. NOT retryable
// by the provider-failure kernel: the watchdog already spent its one retry, and past the `finish` part
// a re-run would duplicate a completed coding step. `cause` retains any underlying error.
export class StreamStallError extends Error {
  override readonly name = 'StreamStallError';
}

export type SubagentConfig<TOOLS extends ToolSet> = {
  model: LanguageModel;
  tools: TOOLS;
  // Full system prompt — typically built with composeSystemPrompt.
  systemPrompt: string;
  // The terminal tool the agent calls to deliver its structured result. Build it at the call site
  // with `tool({ inputSchema: <ZodSchema>, execute: async (x) => x })` — a *concrete* schema, so
  // the AI SDK infers the param type (a generic schema breaks tool() inference). It is registered
  // under SUBMIT_TOOL_NAME; read the validated result back with submittedOutput(result, schema).
  submit: Tool;
  // Step cap; falls back to defaultMaxSteps.
  maxSteps?: number;
  // Per-step LLM request deadline, armed at generate time (see createSubagent — a constructor-level
  // timeout is a verified no-op in ai@6.0.182). Omitted → no deadline, behavior byte-identical to
  // before. Policy-free passthrough: aitm supplies `{ stepMs }` from config; compat sets no default.
  // A per-call `timeout` passed to `agent.generate` wins over this one. See issue #129.
  timeout?: TimeoutConfiguration;
  // Optional per-step hook (the AI SDK's `prepareStep`). Policy-free passthrough: aitm builds one
  // to swap in compacted messages between steps (issue #102), and later a deferred-tool-activation
  // step composes into the SAME function — one prepareStep may return both `messages` and
  // `activeTools`. The compat package stays free of any specific policy. Typed by indexing the
  // SDK's own settings so it matches the ToolLoopAgent constructor exactly (writing
  // `PrepareStepFunction<TOOLS>` here trips its `Record<string, Tool>` constraint under
  // exactOptionalPropertyTypes, since ToolSet's element is a wider Tool union).
  prepareStep?: ToolLoopAgentSettings<never, TOOLS>['prepareStep'];
  // Provider-specific options (the AI SDK's `providerOptions`), armed at generate time for the same
  // reason as `timeout`: ai@6.0.182's `ToolLoopAgent.generate` overwrites constructor settings with
  // the per-call value, so a construction-only value is dropped. Policy-free passthrough — aitm uses
  // it to ride OpenRouter server tools (e.g. `{ openrouter: { tools: [...] } }`, issue #112). A
  // per-call `providerOptions` on `agent.generate` wins. Omitted → no options, byte-identical.
  providerOptions?: ToolLoopAgentSettings<never, TOOLS>['providerOptions'];
  // Per-step callback (the AI SDK's agent-wide `onStepFinish`). Policy-free passthrough: aitm uses it
  // to append each completed step to a persisted transcript (issue #108). Omitted → not registered,
  // behavior byte-identical.
  onStepFinish?: ToolLoopAgentSettings<never, TOOLS>['onStepFinish'];
  // Forwarded to callWithStepTimeout's RetryOptions (slice 01b) so a caller can surface each retry
  // attempt (e.g. to the console) instead of a whole backoff window going silent. Omitted → no sink,
  // byte-identical retry behavior.
  onRetry?: RetryOptions['onRetry'];
  // Optional live-streaming sink (slice 07). When set, the subagent's generate funnel runs via
  // streamText instead of generateText and forwards text + tool-call events here as they arrive; the
  // resolved result is byte-identical in shape either way, so no downstream reader changes. Policy-free
  // passthrough — aitm wires a live renderer; compat sets no default. Omitted → generate untouched,
  // behavior byte-identical. A throw from the sink is swallowed, so a broken renderer can never abort
  // or (via the retry kernel) re-run a generation.
  onStream?: SubagentStreamSink;
  // Overrides for the streaming stall watchdog (slice 07): the mid-stream inactivity window, the
  // post-finish grace window, and (test seam) the timer factory. Only consulted on the streaming path
  // (onStream set); ignored otherwise. Omitted → production defaults (see STREAM_INACTIVITY_MS).
  streamWatchdog?: StreamWatchdogConfig;
  // Run-scoped cancellation (e.g. the CLI's SIGINT handle). An agent is built per run leg, so the
  // signal belongs to its whole lifetime: it is applied to EVERY generate this agent makes, which is
  // the only way cancellation reaches calls the caller does not drive directly — the schema-retry
  // loop (runWithSchemaRetry) owns its own generations. It COMPOSES with a per-call `abortSignal`
  // (both tear the step down) and with the configured `timeout` — see armStepTimeout. Omitted → no
  // signal, behavior byte-identical.
  signal?: AbortSignal;
};

// Wrap a ToolLoopAgent: register the caller's tools plus the `submit` tool, and stop when the step
// budget is hit OR the agent submits. Each concrete subagent factory stays a one-liner over its
// own tools + submit tool.
export function createSubagent<TOOLS extends ToolSet>(
  config: SubagentConfig<TOOLS>,
  defaultMaxSteps: number,
): ToolLoopAgent<never, TOOLS> {
  const agent = new ToolLoopAgent<never, TOOLS>({
    model: config.model,
    tools: { ...config.tools, submit: config.submit },
    instructions: config.systemPrompt,
    stopWhen: [stepCountIs(config.maxSteps ?? defaultMaxSteps), hasToolCall(SUBMIT_TOOL_NAME)],
    ...(config.prepareStep ? { prepareStep: config.prepareStep } : {}),
    // Unlike `timeout`, providerOptions is a persistent agent setting (not an AgentCallParameters
    // per-call field), so the constructor value is forwarded on every generate — no generate-time
    // arming needed. Omitted when unset → byte-identical.
    ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
    // Agent-wide per-step callback (issue #108). Omitted when unset → not registered.
    ...(config.onStepFinish ? { onStepFinish: config.onStepFinish } : {}),
  });
  // Streaming is armed BEFORE the timeout/retry wrapper so the kernel wraps the whole stream (see
  // armStreaming). Omitted onStream → generate untouched, byte-identical to the non-streaming path.
  if (config.onStream !== undefined) {
    armStreaming(agent, config.onStream, resolveStreamWatchdog(config.streamWatchdog));
  }
  if (config.timeout !== undefined || config.onRetry !== undefined || config.signal !== undefined) {
    armStepTimeout(agent, config.timeout, config.onRetry, config.signal);
  }
  return agent;
}

// Arm the per-step deadline (and retry reporting) at generate time. The pinned AI SDK (ai@6.0.182)
// drops a constructor-level `timeout`: `ToolLoopAgent.generate` destructures the per-call `timeout`
// and forwards it to `generateText`, so the prepared constructor settings are overwritten with
// `undefined` on every call that omits it — which is every aitm call site. We therefore wrap
// `generate` to inject the configured timeout unless the caller passed a `timeout` of their own (that
// one means the caller owns the deadline, so we leave the call untouched), and translate the SDK's
// generic abort into a deadline-named error via callWithStepTimeout. `onRetry` rides along
// unconditionally — it is armed even with no configured `timeout`, so a caller that only wants retry
// visibility doesn't have to opt into a deadline to get it.
//
// A caller `abortSignal` is cancellation, NOT a deadline: it COMPOSES with the configured timeout
// rather than replacing it (generateText merges the caller's signal with its own timeout-derived ones,
// so whichever fires first aborts the step). Disarming the deadline on its presence would mean a run
// that opts into cancellation silently loses its stall protection. The signal rides into the kernel so
// a caller-cancelled abort is never relabelled a deadline breach and retries stop on cancel.
function armStepTimeout<TOOLS extends ToolSet>(
  agent: ToolLoopAgent<never, TOOLS>,
  timeout: TimeoutConfiguration | undefined,
  onRetry: RetryOptions['onRetry'],
  runSignal: AbortSignal | undefined,
): void {
  type Generate = ToolLoopAgent<never, TOOLS>['generate'];
  const original = agent.generate.bind(agent) as Generate;
  const wrapped: Generate = async (params) => {
    // The agent's run-scoped signal rides on every call, so a generation the caller does not drive
    // itself (the schema-retry loop's re-invocations) is cancellable too.
    const { signal, release } = mergeSignals(params.abortSignal, runSignal);
    const call = signal === undefined ? params : { ...params, abortSignal: signal };
    try {
      if (call.timeout !== undefined) return await original(call);
      return await callWithStepTimeout(
        () => original(timeout === undefined ? call : { ...call, timeout }),
        timeout,
        {
          ...(onRetry === undefined ? {} : { onRetry }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } finally {
      release();
    }
  };
  agent.generate = wrapped;
}

// Both a per-call `abortSignal` and the agent's run-scoped signal are cancellation, so BOTH must tear
// the step down — preferring one would let a Ctrl-C be swallowed by a call that brought its own
// signal. Only one in play → it is used as-is (no bridge, no listener); both → a linked controller,
// whose `release` must run once the call settles (a run signal outlives many generations, so a
// listener kept per call leaks the finished controller and trips the max-listener warning).
function mergeSignals(
  perCall: AbortSignal | undefined,
  run: AbortSignal | undefined,
): { signal: AbortSignal | undefined; release: () => void } {
  if (perCall === undefined || run === undefined || perCall === run) {
    return { signal: perCall ?? run, release: () => {} };
  }
  const { controller, release } = linkController(perCall, run);
  return { signal: controller.signal, release };
}

// Route the agent's generate funnel through streamText so a live sink observes text and tool-call
// events as they arrive, then resolve to the SAME GenerateTextResult shape agent.generate returns —
// every downstream reader (submittedOutput, generateOverMessages, reportUsage) is byte-identical
// whether the funnel streamed or not. Armed BEFORE armStepTimeout (see createSubagent) so the
// retry/timeout kernel wraps the whole stream unchanged: a transient failure re-invokes streamText
// fresh, a configured deadline aborts it. Only armed when a caller opts in via `onStream`; otherwise
// generate is untouched and behavior is identical (slice 07).
//
// The stream is consumed through the two-regime stall watchdog (see consumeStreamWithWatchdog). The
// regime pivots on the terminal `submit` tool-call — the compat signal that the coding step's answer is
// in. Before it, a stall aborts and re-invokes streamText once (a persistent one throws
// StreamStallError). After it, a stall that outlasts the grace window is a hard StreamStallError too —
// never a re-run, so a finished coding step's PR is never duplicated. A clean drain returns the result.
function armStreaming<TOOLS extends ToolSet>(
  agent: ToolLoopAgent<never, TOOLS>,
  onStream: SubagentStreamSink,
  watchdog: StreamWatchdog,
): void {
  type Generate = ToolLoopAgent<never, TOOLS>['generate'];
  const stream = agent.stream.bind(agent);
  const streamed: Generate = async (params) => {
    let stallRetries = 0;
    while (true) {
      const { controller, release } = linkController(params.abortSignal);
      try {
        const result = await stream({ ...params, abortSignal: controller.signal });
        const outcome = await consumeStreamWithWatchdog(
          result.fullStream,
          {
            onPart: (part) => {
              if (part.type === 'text-delta') {
                emitStreamEvent(onStream, { type: 'text-delta', text: part.text });
              } else if (part.type === 'tool-call') {
                emitStreamEvent(onStream, {
                  type: 'tool-call',
                  toolName: part.toolName,
                  input: part.input,
                });
              } else if (part.type === 'error') {
                // streamText surfaces a provider failure as an `error` part (the fullStream then ends
                // without throwing and the result promises reject with a generic NoOutputGeneratedError).
                // Re-throw the underlying error so the retry/timeout kernel classifies it exactly as it
                // would a generateText throw — a transient 429 stays retryable, a deadline abort a timeout.
                throw part.error;
              }
            },
            // The terminal submit tool-call flips the watchdog into its grace regime. It is the earliest
            // in-stream signal that the step is answered; the SDK's own `finish` part arrives only at
            // stream close, so keying on it alone would leave a lingering provider looking like a stall.
            isFinish: (part) =>
              part.type === 'finish' ||
              (part.type === 'tool-call' && part.toolName === SUBMIT_TOOL_NAME),
            abort: () =>
              controller.abort(new StreamStallError(streamStallMessage(watchdog.inactivityMs))),
          },
          watchdog,
        );
        // A clean close settles the result promises — read them back into the parity result.
        if (outcome === 'drained') return await streamResultToGenerate(result);
        // Post-submit stall: the answer is already produced. Re-running would duplicate the step's side
        // effects (a duplicate-PR hazard), so this is a hard failure — never a retry. (streamResultToGenerate
        // is not called: on an unclosed stream its result promises never settle.)
        if (outcome === 'stalled-grace') {
          throw new StreamStallError(streamGraceMessage(watchdog.graceMs));
        }
        // Pre-submit stall: the abort above tore down the hung stream. Re-run once from scratch; a second
        // stall is a hard failure rather than an unbounded loop.
        if (stallRetries >= MAX_STREAM_STALL_RETRIES) {
          throw new StreamStallError(streamStallMessage(watchdog.inactivityMs));
        }
        stallRetries += 1;
      } finally {
        release();
      }
    }
  };
  agent.generate = streamed;
}

// Resolve caller overrides against the production defaults. Hoisted so createSubagent can call it
// above its definition.
function resolveStreamWatchdog(config: StreamWatchdogConfig | undefined): StreamWatchdog {
  return {
    inactivityMs: config?.inactivityMs ?? STREAM_INACTIVITY_MS,
    graceMs: config?.graceMs ?? STREAM_GRACE_MS,
    timer: config?.timer ?? defaultStreamTimer,
  };
}

function streamStallMessage(inactivityMs: number): string {
  return `Streamed generation stalled: no activity within ${inactivityMs} ms and the single retry did not recover`;
}

function streamGraceMessage(graceMs: number): string {
  return `Streamed generation submitted its answer but the stream did not close within ${graceMs} ms; not re-running to avoid duplicating a completed coding step`;
}

// Real-timer factory: a setTimeout the caller can cancel. Kept portable (no unref — the watchdog is
// always awaited alongside a live stream read, so it never keeps an otherwise-idle process alive).
const defaultStreamTimer: StreamTimerFactory = (ms) => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    expired,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
};

// An AbortController whose signal also fires when any of the outer signals does, so the watchdog owns
// its own abort while still honoring a caller cancel. Portable — avoids AbortSignal.any, which is
// unavailable on Node 20.0–20.2. `release` unhooks the bridge: an outer signal is run-scoped and
// outlives many generations, so a listener retained per stream both leaks the finished controller and
// trips the runtime's max-listener warning on a long run.
function linkController(...outers: Array<AbortSignal | undefined>): {
  controller: AbortController;
  release: () => void;
} {
  const controller = new AbortController();
  const present = outers.filter((s): s is AbortSignal => s !== undefined);
  const aborted = present.find((s) => s.aborted);
  if (aborted !== undefined) {
    controller.abort(aborted.reason);
    return { controller, release: () => {} };
  }
  const unlink = present.map((outer) => {
    const onAbort = () => controller.abort(outer.reason);
    outer.addEventListener('abort', onAbort, { once: true });
    return () => outer.removeEventListener('abort', onAbort);
  });
  return {
    controller,
    release: () => {
      for (const unhook of unlink) unhook();
    },
  };
}

// Drive a live stream through the two-regime stall watchdog (see STREAM_INACTIVITY_MS). Each awaited
// part resets the deadline; the first part for which `isFinish` holds flips the regime from the
// inactivity window to the shorter grace window. On a deadline the stream is aborted and the outcome
// names the regime — 'stalled-active' (mid-stream → caller retries once) or 'stalled-grace'
// (post-finish → caller settles, never retries). A clean end → 'drained'. `onPart` runs for every part
// and may throw (an `error` part); that throw propagates so the retry kernel classifies it exactly as
// on the non-streaming path. The deadline is detected off an injectable timer — not off how the SDK
// surfaces an abort — so the two regimes are deterministic and unit-testable.
export async function consumeStreamWithWatchdog<PART>(
  stream: AsyncIterable<PART>,
  handlers: {
    onPart: (part: PART) => void;
    isFinish: (part: PART) => boolean;
    abort: () => void;
  },
  watchdog: StreamWatchdog,
): Promise<StreamWatchdogOutcome> {
  const iterator = stream[Symbol.asyncIterator]();
  let finished = false;
  while (true) {
    const timer = watchdog.timer(finished ? watchdog.graceMs : watchdog.inactivityMs);
    const step = iterator.next();
    // The step branch handles both settlements so the raw next() is never an unhandled rejection when
    // the timer wins the race and the read is left dangling.
    const raced = await Promise.race([
      step.then(
        (result) => ({ tag: 'next' as const, result }),
        (error) => ({ tag: 'throw' as const, error }),
      ),
      timer.expired.then(() => ({ tag: 'stall' as const })),
    ]);
    if (raced.tag === 'stall') {
      handlers.abort();
      return finished ? 'stalled-grace' : 'stalled-active';
    }
    timer.cancel();
    if (raced.tag === 'throw') throw raced.error;
    if (raced.result.done) return 'drained';
    handlers.onPart(raced.result.value);
    if (handlers.isFinish(raced.result.value)) finished = true;
  }
}

// Fire the streaming sink, swallowing a throw — a broken live renderer must never abort a generation,
// nor (since this runs inside the retry kernel) trigger a re-run of an in-flight coding step.
function emitStreamEvent(onStream: SubagentStreamSink, event: SubagentStreamEvent): void {
  try {
    onStream(event);
  } catch {
    // observability must never break the run
  }
}

// Parity core of the stream funnel: drain the fully-consumed stream's resolved fields into the exact
// GenerateTextResult shape agent.generate produces. `output`/`experimental_output` throw
// NoOutputGeneratedError precisely as a non-streamed result does when no Output spec is set — compat
// never sets one (structured output rides the submit tool), so a caller that ignores them stays
// identical and a stray read fails identically. Every other field is already settled once fullStream
// drains, so awaiting them is immediate.
async function streamResultToGenerate<TOOLS extends ToolSet>(
  result: StreamTextResult<TOOLS, never>,
): Promise<GenerateResult<TOOLS>> {
  return {
    content: await result.content,
    text: await result.text,
    reasoning: await result.reasoning,
    reasoningText: await result.reasoningText,
    files: await result.files,
    sources: await result.sources,
    toolCalls: await result.toolCalls,
    staticToolCalls: await result.staticToolCalls,
    dynamicToolCalls: await result.dynamicToolCalls,
    toolResults: await result.toolResults,
    staticToolResults: await result.staticToolResults,
    dynamicToolResults: await result.dynamicToolResults,
    finishReason: await result.finishReason,
    rawFinishReason: await result.rawFinishReason,
    usage: await result.usage,
    totalUsage: await result.totalUsage,
    warnings: await result.warnings,
    request: await result.request,
    response: await result.response,
    providerMetadata: await result.providerMetadata,
    steps: await result.steps,
    get output(): never {
      throw new NoOutputGeneratedError();
    },
    get experimental_output(): never {
      throw new NoOutputGeneratedError();
    },
  };
}

// A per-step LLM deadline expired. Names the configured bound so a run leg's reason is actionable —
// the SDK aborts a timed-out step with no reason, surfacing only the generic "This operation was
// aborted" otherwise. `cause` retains the original abort error.
export class StepTimeoutError extends Error {
  override readonly name = 'StepTimeoutError';
}

function stepTimeoutMessage(timeout: TimeoutConfiguration): string {
  const ms = typeof timeout === 'number' ? timeout : (timeout.stepMs ?? timeout.totalMs);
  return `LLM step exceeded the configured deadline (${ms} ms)`;
}

// True for an abort/timeout error. The SDK's step timer calls `AbortController.abort()` with no
// reason (→ DOMException 'AbortError'); `AbortSignal.timeout` (the totalMs path) throws
// 'TimeoutError'. Matching both keeps this portable across Bun/Node/Deno without importing the SDK's
// internal helper.
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

// Run a deadline-armed AI SDK call, translating the SDK's generic abort into a StepTimeoutError that
// names the bound. `timeout === undefined` → pass-through (no deadline, raw errors propagate). The
// direct `generateText` call sites use this: they inject the `timeout` key themselves (key-absence
// preserved when unset) and wrap the call here so a stalled provider surfaces a named timeout.
// Every aitm LLM call funnels through here, so it is also the one place to absorb TRANSIENT provider
// failures (rate-limit, overload, 5xx, Kimi's "not found the model … permission denied" — a
// rate-limit dressed as a 404). Without a retry a single hiccup permanently blocks a whole PR group.
// The deadline translation stays inside the retried call so a StepTimeoutError is raised per attempt;
// it is deliberately NOT retryable (see isRetryableProviderError) — a timeout re-run risks doubling
// wall-clock, so it propagates and blocks. The optional `retry` argument forwards RetryOptions
// (notably `onRetry`) into the kernel so a caller can surface each retry attempt to the console.
export async function callWithStepTimeout<T>(
  call: () => Promise<T>,
  timeout: TimeoutConfiguration | undefined,
  retry: RetryOptions = {},
): Promise<T> {
  return callWithRetry(async () => {
    try {
      return await call();
    } catch (err) {
      // A cancelled caller's abort is not a deadline breach: relabelling it would report a Ctrl-C as
      // "the step exceeded its deadline" and hide the cancellation from the caller's error handling.
      if (timeout !== undefined && isAbortError(err) && retry.signal?.aborted !== true) {
        throw new StepTimeoutError(stepTimeoutMessage(timeout), { cause: err });
      }
      throw err;
    }
  }, retry);
}

// Retry an LLM call on transient provider failures with an escalating backoff. Up to 10 retries at
// 1s, 5s, 10s, 15s … (+5s), so a rate-limit window or a brief overload rides through instead of
// blocking the run. Non-transient errors (schema failures, timeouts, aborts, 4xx that aren't
// rate-limits) throw immediately — retrying them just burns tokens. `sleep` is injectable for tests.
export const DEFAULT_LLM_MAX_RETRIES = 10;

export function defaultRetryDelayMs(attemptIndex: number): number {
  // 0 → 1s, then 5s, 10s, 15s … (+5s). Matches the operator-requested schedule.
  return attemptIndex === 0 ? 1_000 : 5_000 * attemptIndex;
}

// Fired just before each backoff sleep so a caller can surface the retry (slice 01b). `attempt` is
// the 1-based retry ordinal, `maxAttempts` mirrors maxRetries, `delayMs` is the wait actually taken
// (a parsed Retry-After when the provider sent one, else the backoff), `reason` a non-empty cause
// label. Enables `Rate limited (HTTP 429), retrying in 15s (3/10)` — never an empty cause line.
export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
};

export type RetryOptions = {
  maxRetries?: number;
  delayMs?: (attemptIndex: number) => number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
  // Observability sink for each retry; a throw here is swallowed so it can never turn a recoverable
  // transient failure into a hard error.
  onRetry?: (info: RetryInfo) => void;
  // The caller's cancellation signal, when one is in flight. Cancellation wins over the kernel's own
  // bookkeeping in two places: no further retry is attempted once it aborts (a backoff window nobody
  // is waiting for would hold the run open for up to a minute), and callWithStepTimeout stops
  // relabelling aborts as deadline breaches. Never used to abort the call itself — the caller already
  // passed it to the SDK, which is what actually tears the request down.
  signal?: AbortSignal;
};

export async function callWithRetry<T>(
  call: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_LLM_MAX_RETRIES;
  const delayMs = opts.delayMs ?? defaultRetryDelayMs;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isRetryable = opts.isRetryable ?? isRetryableProviderError;
  let attempt = 0;
  while (true) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= maxRetries || opts.signal?.aborted === true || !isRetryable(err)) throw err;
      const delay = resolveRetryDelay(err, delayMs(attempt));
      reportRetry(opts.onRetry, {
        attempt: attempt + 1,
        maxAttempts: maxRetries,
        delayMs: delay,
        reason: describeRetryReason(err),
      });
      await sleep(delay);
      attempt += 1;
    }
  }
}

// HTTP statuses worth a retry: rate-limit (429, and Anthropic-style 529 overloaded), request/gateway
// timeouts (408, 504), and transient server/gateway faults (500, 502, 503).
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

// Message signatures of a transient failure across providers, including Kimi's misleading
// "Not found the model <x> or Permission denied" (its coding endpoint returns this for a rate-limit)
// and common network resets. Kept deliberately narrow so a genuine 4xx (bad request, real auth
// failure, unknown model on a non-Kimi provider) is NOT retried.
const RETRYABLE_MESSAGE =
  /rate.?limit|overloaded|too many requests|temporarily unavailable|service unavailable|not found the model.*permission denied|econnreset|etimedout|eai_again|socket hang up|network error|fetch failed/i;

// Read an HTTP status off the assorted shapes provider SDKs throw (AI SDK APICallError.statusCode,
// a bare `status`, or a nested `response.status`).
function readStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [e.statusCode, e.status, e.response?.status]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

// Classify a thrown LLM error as a transient provider failure worth retrying. A deadline
// (StepTimeoutError) and an explicit abort/cancel are never retried; a matching transient HTTP status
// or message is. Exported for direct unit testing.
export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof StepTimeoutError) return false;
  // The stall watchdog already spent its one retry, and past `finish` a re-run would duplicate a
  // completed coding step — so a StreamStallError propagates and blocks rather than being retried.
  if (err instanceof StreamStallError) return false;
  if (isAbortError(err)) return false;
  const status = readStatusCode(err);
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_MESSAGE.test(message);
}

// A provider Retry-After is honored up to this bound; beyond it we cap so one call can never stall a
// whole PR group for more than five minutes on a malformed or hostile header.
const MAX_RETRY_AFTER_MS = 300_000;

// The wait before the next attempt: honor a provider Retry-After when present (capped), else the
// caller's escalating backoff. Kept separate from parsing so parseRetryAfterMs returns the true value.
function resolveRetryDelay(err: unknown, backoffMs: number): number {
  const after = parseRetryAfterMs(err);
  return after === undefined ? backoffMs : Math.min(after, MAX_RETRY_AFTER_MS);
}

// Fire the observability sink, swallowing a throw — a broken progress line must never abort a retry.
function reportRetry(onRetry: RetryOptions['onRetry'], info: RetryInfo): void {
  if (!onRetry) return;
  try {
    onRetry(info);
  } catch {
    // observability must never break the retry loop
  }
}

// A short, non-empty label for why we are retrying, so a progress line never renders an empty cause.
// Prefers the HTTP status (`HTTP 429`); falls back to the error's clipped first line.
function describeRetryReason(err: unknown): string {
  const status = readStatusCode(err);
  if (status !== undefined) return `HTTP ${status}`;
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine.length === 0) return 'transient error';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

// Parse a provider's requested retry delay (ms) from a thrown error: the `Retry-After` /
// `retry-after-ms` headers first (assorted SDK header shapes), then a `try again in Ns` hint in the
// message or raw body. Undefined when absent or unparseable → the caller uses its backoff. Exported
// for direct unit testing. Reference: opencode session/retry.ts.
export function parseRetryAfterMs(err: unknown): number | undefined {
  return retryAfterFromHeaders(err) ?? retryAfterFromBody(err);
}

function retryAfterFromHeaders(err: unknown): number | undefined {
  const explicitMs = readHeader(err, 'retry-after-ms');
  if (explicitMs !== undefined) {
    const ms = Number.parseInt(explicitMs, 10);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const retryAfter = readHeader(err, 'retry-after');
  return retryAfter === undefined ? undefined : retryAfterHeaderToMs(retryAfter);
}

// `Retry-After` is either an integer number of seconds or an HTTP-date (RFC 7231). The date form
// needs the wall clock; clamp to >= 0 so an already-past date retries immediately.
function retryAfterHeaderToMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

// Header bags arrive as a fetch Headers instance (`.get`) or a plain, possibly mixed-case record.
function readHeader(err: unknown, name: string): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as {
    responseHeaders?: unknown;
    headers?: unknown;
    response?: { headers?: unknown };
  };
  for (const container of [e.responseHeaders, e.headers, e.response?.headers]) {
    const value = headerValue(container, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function headerValue(container: unknown, name: string): string | undefined {
  if (typeof container !== 'object' || container === null) return undefined;
  if (typeof (container as { get?: unknown }).get === 'function') {
    const value = (container as { get(header: string): unknown }).get(name);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
    if (key.toLowerCase() === lower && typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

// Some providers put the delay only in prose ("...please try again in 12s"), in the message or the
// raw response body. Read the first number + time unit; nothing matched → undefined.
function retryAfterFromBody(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { message?: unknown; responseBody?: unknown };
  for (const text of [e.message, e.responseBody]) {
    if (typeof text === 'string') {
      const ms = hintTextToMs(text);
      if (ms !== undefined) return ms;
    }
  }
  return undefined;
}

function hintTextToMs(text: string): number | undefined {
  const match =
    /(?:try again|retry)[^0-9]{0,20}?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\b/i.exec(text);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(value)) return undefined;
  return (match[2] ?? '').toLowerCase().startsWith('m')
    ? Math.round(value)
    : Math.round(value * 1000);
}

// Structural shape of the agent.generate() result fields submittedOutput reads — kept minimal so
// it doesn't couple to the SDK's deep generic result type.
type StepsResult = {
  steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string; input: unknown }> }>;
};

// Typed extraction outcome — never a throw. `no-submission` = the agent stopped without ever
// calling `submit`; `invalid` = it called `submit` but the input failed the Zod schema (including
// input the SDK left as a raw string after a JSON-parse failure). Callers map each to their own
// blocked/error/wontfix state, or route through runWithSchemaRetry to auto-correct first.
export type SubmittedOutput<OUTPUT> =
  | { ok: true; value: OUTPUT }
  | { ok: false; reason: 'no-submission' }
  | { ok: false; reason: 'invalid'; issues: readonly z.core.$ZodIssue[] };

// Extract and validate the result the agent submitted via the `submit` tool. NEVER throws: a
// missing submission is `no-submission`, a schema-invalid one is `invalid` with the Zod issues, so
// a single malformed `submit` no longer surfaces a ZodError up the run leg. Pass the same Zod
// schema the submit tool was built with. Because `hasToolCall(SUBMIT_TOOL_NAME)` matches even a
// schema-invalid call, every mismatch already lands in `result.steps` — this is the one detection
// point for both failure modes, with no dependency on SDK tool-error feedback reaching the model.
export function submittedOutput<OUTPUT>(
  result: StepsResult,
  outputSchema: z.ZodType<OUTPUT>,
): SubmittedOutput<OUTPUT> {
  const call = result.steps
    .flatMap((step) => step.toolCalls)
    .find((toolCall) => toolCall.toolName === SUBMIT_TOOL_NAME);
  if (!call) return { ok: false, reason: 'no-submission' };
  const parsed = outputSchema.safeParse(call.input);
  if (parsed.success) return { ok: true, value: parsed.data };
  // Weak models often call submit with a JSON STRING (optionally ```-fenced) instead of the object
  // the schema expects (issue #185; live: a run died at pr-open, one step from success). Salvage that
  // shape upstream of the #101 retry kernel — parse and re-validate — so retries only spend on
  // genuinely wrong payloads. A non-string, non-parsing, or still-invalid value keeps the existing
  // typed `invalid` result (with the parsed value's issues when it parsed but didn't validate).
  if (typeof call.input === 'string') {
    const salvaged = salvageJsonString(call.input);
    if (salvaged.parsed) {
      const reparsed = outputSchema.safeParse(salvaged.value);
      return reparsed.success
        ? { ok: true, value: reparsed.data }
        : { ok: false, reason: 'invalid', issues: reparsed.error.issues };
    }
  }
  return { ok: false, reason: 'invalid', issues: parsed.error.issues };
}

// How many nested JSON-string envelopes to peel. A model that double-encodes once will occasionally
// do it twice; past three the payload is not an envelope problem, it is a confused model.
const MAX_JSON_PEELS = 3;

// Parse a submit payload that arrived as a JSON string instead of the object the schema expects.
//
// This is not a rare fumble: `ai@6`'s parseToolCall records an invalid tool call rather than dropping
// it (`input = parsedInput.success ? parsedInput.value : toolCall.input`), so a double-encoded
// `arguments` yields a STRING sitting in `steps[].toolCalls[].input`, and every submit surface then
// reports the same undiagnosable `<root>: expected object, received string`. On the Planner, Worker
// manifest, and Reviewer that is not a degraded PR body — those have no fallback, so a missed
// envelope blocks the group outright. Hence: peel nested envelopes, tolerate a forgiving code fence
// (the strict `^```…\n…\n```$` form missed a fence with no trailing newline, and any fence followed
// by prose), and as a last resort take the first balanced `{…}` region out of a narrated answer.
//
// Recovery is always upstream of validation, never instead of it: the caller re-validates whatever
// comes back, so nothing here can widen what the schema accepts. `{ parsed: false }` keeps the
// caller's raw-value issues. See issue #185.
function salvageJsonString(raw: string): { parsed: true; value: unknown } | { parsed: false } {
  let current: unknown = raw;
  for (let peel = 0; peel < MAX_JSON_PEELS; peel += 1) {
    if (typeof current !== 'string') return { parsed: true, value: current };
    const next = parseJsonish(current);
    if (!next.parsed) return peel === 0 ? { parsed: false } : { parsed: true, value: current };
    current = next.value;
  }
  return { parsed: true, value: current };
}

// One layer: strip a code fence if present, parse as JSON, else pull the first balanced object out
// of surrounding narration.
function parseJsonish(raw: string): { parsed: true; value: unknown } | { parsed: false } {
  const body = stripCodeFence(raw.trim());
  try {
    return { parsed: true, value: JSON.parse(body) };
  } catch {
    const embedded = firstBalancedObject(body);
    if (embedded === null) return { parsed: false };
    try {
      return { parsed: true, value: JSON.parse(embedded) };
    } catch {
      return { parsed: false };
    }
  }
}

// Drop a leading ```/```json fence and everything from the closing fence onward. Forgiving where the
// strict anchored form was not: no trailing newline before the close, and prose after it.
function stripCodeFence(text: string): string {
  const opened = /^```[^\n]*\n/.exec(text);
  if (!opened) return text;
  const rest = text.slice(opened[0].length);
  const closed = rest.indexOf('```');
  return (closed === -1 ? rest : rest.slice(0, closed)).trim();
}

// The first brace-balanced `{…}` region, so `Here is the composition:\n{…}\nHope that helps` still
// yields the object. String- and escape-aware: a `}` inside a JSON string value cannot end the scan,
// which is what makes this safe on a PR body full of prose and braces. null when there is none.
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Human-readable one-line rendering of Zod issues, for a caller's blocked/error/wontfix reason
// text (the model-facing corrective message is built separately by runWithSchemaRetry).
export function formatSubmitIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

export type SchemaRetryOptions = {
  // Corrective re-invocations after the first attempt. Default 2 → up to 3 total generations.
  maxRetries?: number;
  // Optional per-generation usage sink — invoked once per attempt with that generation's total usage,
  // resolved model id, and per-generate diagnostics (issue #168: this attempt's wall-clock + whether it
  // was a corrective re-generation), so a caller can meter cost, latency, and retry pressure across the
  // whole loop (issue #114). `providerMetadata` is not forwarded here (the schema-retry path does not
  // surface cache_discount), kept in the signature only to align with the aitm-side OnUsage positions.
  // Policy-free passthrough; a throwing sink must not break the loop.
  onUsage?: (
    usage: LanguageModelUsage,
    modelId: string | undefined,
    providerMetadata?: ProviderMetadata,
    meta?: { latencyMs?: number; retries?: number },
  ) => void;
};

// Run a subagent to a schema-valid `submit`, correcting a botched attempt in-conversation. Runs
// `generate`, extracts via submittedOutput; on `no-submission`/`invalid` it re-invokes the SAME
// agent with the full prior message history (so the model sees its own bad call and the SDK's
// tool-error result) plus ONE corrective user message quoting the validation issues. Bounded by
// maxRetries; returns the last typed failure once retries exhaust. A success on retry is
// indistinguishable to the caller from a first-try success. This is the recovery layer for the
// number-one weak-model failure mode: one mangled schema no longer ends the run leg.
export async function runWithSchemaRetry<TOOLS extends ToolSet, OUTPUT>(
  agent: ToolLoopAgent<never, TOOLS>,
  schema: z.ZodType<OUTPUT>,
  prompt: string,
  options: SchemaRetryOptions = {},
): Promise<SubmittedOutput<OUTPUT>> {
  const maxRetries = options.maxRetries ?? 2;
  let messages: ModelMessage[] = [{ role: 'user', content: prompt }];
  let last: SubmittedOutput<OUTPUT> = { ok: false, reason: 'no-submission' };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // One replay step, shared with continuation (#107): run the agent and accumulate the full
    // conversation (prior turns + the model's response — its call and the SDK's tool-error result).
    const startedAt = Date.now();
    const step = await generateOverMessages(agent, messages);
    // retries: 1 for every attempt past the first, so a bucket sums to "corrective re-generations"
    // (issue #168). latencyMs: this attempt's wall-clock.
    reportUsage(options.onUsage, step.result, {
      latencyMs: Date.now() - startedAt,
      retries: attempt > 0 ? 1 : 0,
    });
    last = submittedOutput(step.result, schema);
    if (last.ok) return last;
    if (attempt === maxRetries) break;
    messages = [...step.messages, { role: 'user', content: correctiveMessage(last) }];
  }
  return last;
}

// The generate result an agent produces — kept as an indexed type so callers read `.steps` /
// `.response.messages` without restating the SDK's deep result generic.
type GenerateResult<TOOLS extends ToolSet> = Awaited<
  ReturnType<ToolLoopAgent<never, TOOLS>['generate']>
>;

// Feed a generation's total usage + resolved model id to an optional sink (issue #114). The
// schema-retry loop hides the raw result from planner/reviewer callers, so it meters here.
// Fire-and-forget: a throwing sink or a missing field must never break the run leg.
function reportUsage<TOOLS extends ToolSet>(
  onUsage: SchemaRetryOptions['onUsage'],
  result: GenerateResult<TOOLS>,
  meta?: { latencyMs?: number; retries?: number },
): void {
  if (!onUsage) return;
  try {
    onUsage(result.totalUsage, result.response.modelId, undefined, meta);
  } catch {
    // observability must never break the run
  }
}

// A completed subagent run plus the full conversation, so a later call can continue it (#107).
export type SubagentHandle<TOOLS extends ToolSet> = {
  agent: ToolLoopAgent<never, TOOLS>;
  // The request messages plus every assistant/tool message the run produced, in order.
  messages: ModelMessage[];
};

// A run's raw result (for submittedOutput) paired with the handle to continue from.
export type SubagentRun<TOOLS extends ToolSet> = {
  result: GenerateResult<TOOLS>;
  handle: SubagentHandle<TOOLS>;
};

// The one replay primitive: run the agent over `messages`, returning the result and the conversation
// after it (input + response.messages). Schema-retry (#101) and continuation (#107) both build on it,
// so there is never a second parallel replay path.
async function generateOverMessages<TOOLS extends ToolSet>(
  agent: ToolLoopAgent<never, TOOLS>,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<{ result: GenerateResult<TOOLS>; messages: ModelMessage[] }> {
  const result = await agent.generate({
    messages,
    // Key-absence preserved when unset, so a signal-free call is byte-identical to before.
    ...(signal === undefined ? {} : { abortSignal: signal }),
  });
  return { result, messages: [...messages, ...result.response.messages] };
}

// Cancellation for one subagent run. The signal is handed to the SDK as `abortSignal`, so aborting it
// tears down the in-flight request (and, on the streaming path, the stream) instead of waiting the
// generation out. It COMPOSES with the subagent's configured per-step deadline rather than replacing
// it — see armStepTimeout. Omitted → no signal, behavior byte-identical.
export type SubagentRunOptions = {
  signal?: AbortSignal;
};

// Run a subagent from a fresh prompt, returning its result and a handle to continue the conversation.
export async function runSubagent<TOOLS extends ToolSet>(
  agent: ToolLoopAgent<never, TOOLS>,
  prompt: string,
  options: SubagentRunOptions = {},
): Promise<SubagentRun<TOOLS>> {
  const { result, messages } = await generateOverMessages(
    agent,
    [{ role: 'user', content: prompt }],
    options.signal,
  );
  return { result, handle: { agent, messages } };
}

// Continue a completed run: re-invoke the SAME agent with the retained messages (verbatim — prior
// tool calls and results included) plus one new user message. A fresh step budget applies, and
// submittedOutput on the result reflects only this run's submission. Callers may pass a handle whose
// messages were externally reshaped (e.g. compacted summary + tail) — they are used as-is.
export async function continueSubagent<TOOLS extends ToolSet>(
  handle: SubagentHandle<TOOLS>,
  followUpPrompt: string,
  options: SubagentRunOptions = {},
): Promise<SubagentRun<TOOLS>> {
  const { result, messages } = await generateOverMessages(
    handle.agent,
    [...handle.messages, { role: 'user', content: followUpPrompt }],
    options.signal,
  );
  return { result, handle: { agent: handle.agent, messages } };
}

// Corrective user message for a botched `submit`, exported so a caller running its own
// continuation-based schema loop (e.g. the Worker's manifest planning, #107) reuses the exact wording.
export function correctiveMessage(
  failure: { reason: 'no-submission' } | { reason: 'invalid'; issues: readonly z.core.$ZodIssue[] },
): string {
  if (failure.reason === 'no-submission') {
    return `You did not call the \`${SUBMIT_TOOL_NAME}\` tool. Call \`${SUBMIT_TOOL_NAME}\` now with a single object that matches the required schema.`;
  }
  return `Your \`${SUBMIT_TOOL_NAME}\` input failed schema validation:\n${failure.issues
    .map((i) => `- ${i.path.join('.') || '<root>'}: ${i.message}`)
    .join(
      '\n',
    )}\nCall \`${SUBMIT_TOOL_NAME}\` again with a corrected object that fixes every issue above.`;
}

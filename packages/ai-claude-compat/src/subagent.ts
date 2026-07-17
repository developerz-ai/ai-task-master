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
  if (config.timeout !== undefined) armStepTimeout(agent, config.timeout);
  return agent;
}

// Arm the per-step deadline at generate time. The pinned AI SDK (ai@6.0.182) drops a
// constructor-level `timeout`: `ToolLoopAgent.generate` destructures the per-call `timeout` and
// forwards it to `generateText`, so the prepared constructor settings are overwritten with
// `undefined` on every call that omits it — which is every aitm call site. We therefore wrap
// `generate` to inject the configured timeout when the caller supplied neither a `timeout` nor an
// `abortSignal` (either means the caller owns the deadline, so we leave it untouched), and translate
// the SDK's generic abort into a deadline-named error via callWithStepTimeout.
function armStepTimeout<TOOLS extends ToolSet>(
  agent: ToolLoopAgent<never, TOOLS>,
  timeout: TimeoutConfiguration,
): void {
  type Generate = ToolLoopAgent<never, TOOLS>['generate'];
  const original = agent.generate.bind(agent) as Generate;
  const wrapped: Generate = (params) => {
    if (params.timeout !== undefined || params.abortSignal !== undefined) return original(params);
    return callWithStepTimeout(() => original({ ...params, timeout }), timeout);
  };
  agent.generate = wrapped;
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
// wall-clock, so it propagates and blocks.
export async function callWithStepTimeout<T>(
  call: () => Promise<T>,
  timeout: TimeoutConfiguration | undefined,
): Promise<T> {
  return callWithRetry(async () => {
    try {
      return await call();
    } catch (err) {
      if (timeout !== undefined && isAbortError(err)) {
        throw new StepTimeoutError(stepTimeoutMessage(timeout), { cause: err });
      }
      throw err;
    }
  });
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

export type RetryOptions = {
  maxRetries?: number;
  delayMs?: (attemptIndex: number) => number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
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
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      await sleep(delayMs(attempt));
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
  if (isAbortError(err)) return false;
  const status = readStatusCode(err);
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_MESSAGE.test(message);
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

// Parse a submit payload that arrived as a JSON string, tolerating a single ```-fenced wrapper (the
// two dominant weak-model fumble shapes). `{ parsed: false }` when it isn't valid JSON, so the caller
// keeps the raw-value validation issues. See issue #185.
function salvageJsonString(raw: string): { parsed: true; value: unknown } | { parsed: false } {
  const trimmed = raw.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  const body = (fenced ? (fenced[1] ?? '') : trimmed).trim();
  try {
    return { parsed: true, value: JSON.parse(body) };
  } catch {
    return { parsed: false };
  }
}

// Human-readable one-line rendering of Zod issues, for a caller's blocked/error/wontfix reason
// text (the model-facing corrective message is built separately by runWithSchemaRetry).
export function formatSubmitIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

export type SchemaRetryOptions = {
  // Corrective re-invocations after the first attempt. Default 2 → up to 3 total generations.
  maxRetries?: number;
  // Optional per-generation usage sink — invoked once per attempt with that generation's total usage
  // and resolved model id, so a caller can meter cost across the whole retry loop (issue #114).
  // Policy-free passthrough; a throwing sink must not break the loop.
  onUsage?: (usage: LanguageModelUsage, modelId: string | undefined) => void;
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
    const step = await generateOverMessages(agent, messages);
    reportUsage(options.onUsage, step.result);
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
): void {
  if (!onUsage) return;
  try {
    onUsage(result.totalUsage, result.response.modelId);
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
): Promise<{ result: GenerateResult<TOOLS>; messages: ModelMessage[] }> {
  const result = await agent.generate({ messages });
  return { result, messages: [...messages, ...result.response.messages] };
}

// Run a subagent from a fresh prompt, returning its result and a handle to continue the conversation.
export async function runSubagent<TOOLS extends ToolSet>(
  agent: ToolLoopAgent<never, TOOLS>,
  prompt: string,
): Promise<SubagentRun<TOOLS>> {
  const { result, messages } = await generateOverMessages(agent, [
    { role: 'user', content: prompt },
  ]);
  return { result, handle: { agent, messages } };
}

// Continue a completed run: re-invoke the SAME agent with the retained messages (verbatim — prior
// tool calls and results included) plus one new user message. A fresh step budget applies, and
// submittedOutput on the result reflects only this run's submission. Callers may pass a handle whose
// messages were externally reshaped (e.g. compacted summary + tail) — they are used as-is.
export async function continueSubagent<TOOLS extends ToolSet>(
  handle: SubagentHandle<TOOLS>,
  followUpPrompt: string,
): Promise<SubagentRun<TOOLS>> {
  const { result, messages } = await generateOverMessages(handle.agent, [
    ...handle.messages,
    { role: 'user', content: followUpPrompt },
  ]);
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

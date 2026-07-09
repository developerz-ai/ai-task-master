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
  type ModelMessage,
  stepCountIs,
  type Tool,
  ToolLoopAgent,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import { type EnvInfo, envBlock } from './env-block.ts';

// The tool a subagent calls to deliver its final structured result.
export const SUBMIT_TOOL_NAME = 'submit';

// Build a subagent system prompt: caller style/context + role prefix + an <env> system-context
// block (so the model knows the worktree cwd, platform, runtime, date). The cwd is per-worktree,
// so this is composed at the wiring site rather than baked into a static role prefix. Pass a
// string cwd for the common case, or a full EnvInfo to control the git/date fields.
export function composeSystemPrompt(
  style: string,
  rolePrefix: string,
  env: string | EnvInfo,
): string {
  const info: EnvInfo = typeof env === 'string' ? { cwd: env, isGitRepo: true } : env;
  return `${style}${rolePrefix}\n${envBlock(info)}`;
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
};

// Wrap a ToolLoopAgent: register the caller's tools plus the `submit` tool, and stop when the step
// budget is hit OR the agent submits. Each concrete subagent factory stays a one-liner over its
// own tools + submit tool.
export function createSubagent<TOOLS extends ToolSet>(
  config: SubagentConfig<TOOLS>,
  defaultMaxSteps: number,
): ToolLoopAgent<never, TOOLS> {
  return new ToolLoopAgent<never, TOOLS>({
    model: config.model,
    tools: { ...config.tools, submit: config.submit },
    instructions: config.systemPrompt,
    stopWhen: [stepCountIs(config.maxSteps ?? defaultMaxSteps), hasToolCall(SUBMIT_TOOL_NAME)],
  });
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
  if (!parsed.success) return { ok: false, reason: 'invalid', issues: parsed.error.issues };
  return { ok: true, value: parsed.data };
}

// Human-readable one-line rendering of Zod issues, for a caller's blocked/error/wontfix reason
// text (the model-facing corrective message is built separately by runWithSchemaRetry).
export function formatSubmitIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

export type SchemaRetryOptions = {
  // Corrective re-invocations after the first attempt. Default 2 → up to 3 total generations.
  maxRetries?: number;
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
    const result = await agent.generate({ messages });
    last = submittedOutput(result, schema);
    if (last.ok) return last;
    if (attempt === maxRetries) break;
    // Continue the same conversation: prior turns + the model's response (its invalid call and the
    // SDK's tool-error result are both in response.messages) + one corrective user message.
    messages = [
      ...messages,
      ...result.response.messages,
      { role: 'user', content: correctiveMessage(last) },
    ];
  }
  return last;
}

function correctiveMessage(
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

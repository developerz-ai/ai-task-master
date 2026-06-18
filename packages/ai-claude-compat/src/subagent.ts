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

// Extract and validate the result the agent submitted via the `submit` tool. Returns undefined if
// the agent stopped without submitting (e.g. exhausted the step budget) — callers map that to their
// own blocked/error state, mirroring the old empty-output handling. Pass the same Zod schema the
// submit tool was built with.
export function submittedOutput<OUTPUT>(
  result: StepsResult,
  outputSchema: z.ZodType<OUTPUT>,
): OUTPUT | undefined {
  const call = result.steps
    .flatMap((step) => step.toolCalls)
    .find((toolCall) => toolCall.toolName === SUBMIT_TOOL_NAME);
  if (!call) return undefined;
  return outputSchema.parse(call.input);
}

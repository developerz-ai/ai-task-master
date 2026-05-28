// Provider-agnostic subagent scaffolding for the Vercel AI SDK: compose a system prompt with an
// <env> block, and wrap the `ToolLoopAgent` construction (the subagents-as-tools pattern) behind
// a single factory so callers don't repeat the model/tools/instructions/stopWhen boilerplate.

import { type LanguageModel, type Output, stepCountIs, ToolLoopAgent, type ToolSet } from 'ai';
import { type EnvInfo, envBlock } from './env-block.ts';

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

export type SubagentConfig<TOOLS extends ToolSet, OUTPUT extends Output.Output> = {
  model: LanguageModel;
  tools: TOOLS;
  // Full system prompt — typically built with composeSystemPrompt.
  systemPrompt: string;
  // Structured-output spec (Output.object(...)) the agent must satisfy.
  output: OUTPUT;
  // Step cap; falls back to defaultMaxSteps.
  maxSteps?: number;
};

// Wrap a ToolLoopAgent. Maps systemPrompt → instructions and maxSteps → a stepCountIs stop
// condition, so each concrete subagent factory is a one-liner over its own tools + output type.
export function createSubagent<TOOLS extends ToolSet, OUTPUT extends Output.Output>(
  config: SubagentConfig<TOOLS, OUTPUT>,
  defaultMaxSteps: number,
): ToolLoopAgent<never, TOOLS, OUTPUT> {
  return new ToolLoopAgent<never, TOOLS, OUTPUT>({
    model: config.model,
    tools: config.tools,
    instructions: config.systemPrompt,
    output: config.output,
    stopWhen: stepCountIs(config.maxSteps ?? defaultMaxSteps),
  });
}

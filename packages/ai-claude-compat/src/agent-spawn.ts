// Bridge an AgentDefinition-shaped spec to a model-invocable AI SDK tool (issue #126). Calling the
// returned tool spawns a fresh, bounded child loop (`generateText` + a step cap) that surveys with
// the supplied read-only toolset and returns a self-contained conclusion. The child sees the full
// file text; the parent's context holds only the answer — this is the delegation that keeps a
// survey phase from ingesting raw dumps into a long-lived conversation.
//
// Provider-agnostic: `model` is a plain injected LanguageModel handle, no Anthropic SDK. The child
// shares NO parent conversation — each call's `prompt` must be self-contained (stated in the tool
// description). Read-only enforcement is by explicit `allowedTools` allowlist, never name-sniffing.
// Nesting is bounded two ways: a construction-time check forbids a toolset that holds its own spawn
// tool, and a run-time depth guard (threaded via experimental_context) caps transitive A→B→A chains.

import {
  generateText,
  type LanguageModel,
  stepCountIs,
  type TimeoutConfiguration,
  type Tool,
  type ToolSet,
  tool,
} from 'ai';
import { z } from 'zod';
import type { AgentDefinition } from './agents-loader.ts';
import { callWithStepTimeout } from './subagent.ts';

// The subset of AgentDefinition makeAgentTool consumes: `name` is the ToolSet key callers mount the
// returned tool under, `description` is the tool description, `systemPrompt` is the child's system.
export type AgentToolSpec = Pick<AgentDefinition, 'name' | 'description' | 'systemPrompt'>;

export type AgentToolOptions = {
  // Child model handle (fast tier at the aitm call site).
  model: LanguageModel;
  // Child toolset — every key must appear in allowedTools or construction throws.
  tools: ToolSet;
  // Explicit allowlist of permitted tool names. Enforcement is by allowlist, not name inspection,
  // so a renamed or MCP-supplied read tool still passes iff the caller vouches for it.
  allowedTools: readonly string[];
  // Child step cap; a child that exhausts it still returns its last text (or a no-conclusion line).
  maxSteps?: number;
  // Cap on transitive subagent nesting — how many agent frames may sit on the stack at once. A call
  // at or past the cap is refused before it spawns. Defaults to DEFAULT_AGENT_TOOL_MAX_DEPTH; a
  // non-finite or non-positive value falls back to the default so the guard can't be turned off.
  maxDepth?: number;
  // Truncation cap on the returned text; output past it is cut with an explicit marker.
  maxOutputChars?: number;
  // Optional tighter child deadline. The parent's per-step deadline already propagates via the
  // execute abortSignal (#129); this bounds the child more aggressively when a caller wants it.
  timeout?: TimeoutConfiguration;
  // Optional token-usage sink (issue #114). Fired once per generate call with the child's totalUsage,
  // modelId, and providerMetadata. Fire-and-forget: a recording error must never break the run.
  onUsage?: (
    usage: import('ai').LanguageModelUsage,
    modelId: string | undefined,
    providerMetadata?: import('ai').ProviderMetadata,
  ) => void;
};

export const DEFAULT_AGENT_TOOL_MAX_STEPS = 15;
export const DEFAULT_AGENT_TOOL_MAX_OUTPUT_CHARS = 4000;
// Appended when the child's final text is cut at maxOutputChars.
export const AGENT_TOOL_TRUNCATION_MARKER = '\n\n[output truncated]';
// Returned when the child stopped without producing final assistant text (e.g. step-cap exhaustion
// on a tool call). An informative line rather than an empty string so the parent isn't left guessing.
export const AGENT_TOOL_NO_CONCLUSION = '(no conclusion: the survey ended without a final answer)';
// Prefix on the line returned when the child's provider errored — caught, never thrown into the
// parent step, so one flaky survey can't abort the parent's whole generate.
export const AGENT_TOOL_ERROR_PREFIX = 'survey failed: ';
// Default cap on transitive subagent nesting. 1 = a single level of delegation, matching today's
// read-only survey design (the survey toolset carries no agent tool, so depth never exceeds 1).
// Raising it lets a spawned child spawn its own subagents that many levels deep.
export const DEFAULT_AGENT_TOOL_MAX_DEPTH = 1;
// Prefix on the line returned when a call is refused for exceeding the depth cap — returned, never
// thrown, so a capped delegation path degrades to an informative answer instead of aborting the parent.
export const AGENT_TOOL_DEPTH_EXCEEDED_PREFIX = 'survey refused: subagent depth cap reached';

// Thrown at construction (not at call time) when the toolset violates the read-only contract.
export class AgentToolConstructionError extends Error {
  override readonly name = 'AgentToolConstructionError';
}

const agentToolInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'A self-contained question — the child shares no parent context, so include every detail it needs.',
    ),
});

export type AgentToolInput = z.infer<typeof agentToolInputSchema>;

// Transitive depth is threaded through the AI SDK's experimental_context, which the SDK passes by
// reference to every tool.execute in a generation (its "treat as immutable / mutation races" contract
// proves it is not cloned). A child sees its own depth without any change to the tool input schema or
// caller wiring. The key is a Symbol so it can't collide with a caller's own context fields, and
// object spread copies it, so an existing context object rides through untouched.
const AGENT_DEPTH_KEY: unique symbol = Symbol('aitm.agent-spawn.depth');

function readAgentDepth(context: unknown): number {
  if (typeof context !== 'object' || context === null) return 0;
  const depth = (context as Record<symbol, unknown>)[AGENT_DEPTH_KEY];
  return typeof depth === 'number' && Number.isFinite(depth) && depth >= 0 ? depth : 0;
}

function withAgentDepth(context: unknown, depth: number): unknown {
  const base = typeof context === 'object' && context !== null ? context : {};
  return { ...base, [AGENT_DEPTH_KEY]: depth };
}

export function makeAgentTool(
  spec: AgentToolSpec,
  opts: AgentToolOptions,
): Tool<AgentToolInput, string> {
  const allowed = new Set(opts.allowedTools);
  for (const key of Object.keys(opts.tools)) {
    // No recursion: the child toolset must never contain the spawn tool itself.
    if (key === spec.name) {
      throw new AgentToolConstructionError(
        `agent tool "${spec.name}" cannot contain itself in its own toolset (no recursion)`,
      );
    }
    if (!allowed.has(key)) {
      throw new AgentToolConstructionError(
        `agent tool "${spec.name}" toolset carries "${key}", which is outside the allowedTools allowlist`,
      );
    }
  }

  const maxSteps = opts.maxSteps ?? DEFAULT_AGENT_TOOL_MAX_STEPS;
  // A non-finite or non-positive cap would silently disable truncation; fall back to the default so
  // the bound can never be turned off by accident.
  const requestedMax = opts.maxOutputChars ?? DEFAULT_AGENT_TOOL_MAX_OUTPUT_CHARS;
  const maxOutputChars =
    Number.isFinite(requestedMax) && requestedMax > 0
      ? requestedMax
      : DEFAULT_AGENT_TOOL_MAX_OUTPUT_CHARS;
  // Same non-finite/non-positive fallback as maxOutputChars: the depth cap must never be disablable.
  const requestedMaxDepth = opts.maxDepth ?? DEFAULT_AGENT_TOOL_MAX_DEPTH;
  const maxDepth =
    Number.isFinite(requestedMaxDepth) && requestedMaxDepth > 0
      ? requestedMaxDepth
      : DEFAULT_AGENT_TOOL_MAX_DEPTH;

  return tool({
    description: spec.description,
    inputSchema: agentToolInputSchema,
    // execute is concurrency-safe: it closes over no mutable state, so parallel calls (independent
    // explore tool calls in one assistant message) never corrupt each other.
    execute: async ({ prompt }, options): Promise<string> => {
      // Transitive depth guard. The construction-time check above stops a toolset that literally holds
      // its own spawn tool; this stops an indirect cycle (A→B→A) or an over-deep fan-out at run time,
      // where the offending tool is a different handle the static check can't see. Refuse before
      // spawning — returned, not thrown, so a capped path degrades to a message (like a provider error)
      // instead of aborting the parent step, and the refused generate is never paid for.
      const parentDepth = readAgentDepth(options.experimental_context);
      if (parentDepth >= maxDepth) {
        return `${AGENT_TOOL_DEPTH_EXCEEDED_PREFIX} (depth ${parentDepth}, cap ${maxDepth}) — cannot delegate deeper; do this work directly.`;
      }
      const childContext = withAgentDepth(options.experimental_context, parentDepth + 1);
      try {
        const result = await callWithStepTimeout(
          () =>
            generateText({
              model: opts.model,
              system: spec.systemPrompt,
              tools: opts.tools,
              prompt,
              stopWhen: stepCountIs(maxSteps),
              // Carry the incremented depth into the child so any agent tool it invokes sees the frame
              // it adds and the guard keeps counting down the chain.
              experimental_context: childContext,
              // Forward the parent's per-step deadline (#129) so a stalled child can't outlive the
              // parent step; a caller-supplied opts.timeout bounds it tighter still.
              ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
              ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
            }),
          opts.timeout,
        );
        // Report token usage to the optional sink (fire-and-forget, never breaks the run).
        if (opts.onUsage) {
          try {
            const resultAny = result as unknown as {
              response?: { modelId?: string; providerMetadata?: unknown };
            };
            opts.onUsage(
              result.totalUsage,
              resultAny.response?.modelId,
              resultAny.response?.providerMetadata as import('ai').ProviderMetadata | undefined,
            );
          } catch {
            // Swallow recording errors — a broken sink must never abort the run.
          }
        }
        const text = result.text.trim();
        if (text === '') return AGENT_TOOL_NO_CONCLUSION;
        if (text.length <= maxOutputChars) return text;
        // Reserve room for the marker so the returned string never exceeds the advertised cap.
        const budget = Math.max(0, maxOutputChars - AGENT_TOOL_TRUNCATION_MARKER.length);
        return text.slice(0, budget) + AGENT_TOOL_TRUNCATION_MARKER;
      } catch (err) {
        return `${AGENT_TOOL_ERROR_PREFIX}${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

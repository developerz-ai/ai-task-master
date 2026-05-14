// Canonical capability defaults — all OpenRouter routes (docs/auth.md §"LLM provider").
// User-set models.{generic,smart,coding,fast} always wins; these only fill gaps.
//
// We don't fork defaults by AgentConfigFlavor (CLAUDE.md vs AGENTS.md). Flavor is a
// *style* signal, not a *vendor* signal — every model goes through OpenRouter, so a
// project's convention file does not constrain which model serves a request. The
// flavor only affects which markdown is fed to subagent system prompts.
//
// docs/agent-config-detection.md, docs/config.md, docs/runtime.md

import type { Capability } from '../config/schema.ts';

// Tier mapping rationale (Claude family via OpenRouter — the most flexible coding stack today):
//   haiku  → fast    : routing, orchestration, summarization (toModelOutput compaction)
//   sonnet → generic : default fallback for any unspecified tier
//   opus   → smart   : Planner, Reviewer (architectural reasoning, critique)
//   opus   → coding  : Worker (best-in-class code generation)
export const DEFAULT_MODELS: Record<Capability, string> = {
  fast: 'anthropic/claude-haiku-4.5',
  generic: 'anthropic/claude-sonnet-4.6',
  smart: 'anthropic/claude-opus-4.7',
  coding: 'anthropic/claude-opus-4.7',
};

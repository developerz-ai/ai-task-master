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
//   opus (Opus 5) → smart : Planner, Reviewer (architectural reasoning, critique)
//   opus   → coding  : Worker (best-in-class code generation)
// Prompt caching (issue #109): all four defaults route to anthropic/* , so every default handle is
// built with `cache_control: { type: 'ephemeral' }` — the stable prefix (system prompt + tool defs,
// re-sent every step of a multi-step run) bills at the cached rate. OpenRouter's automatic caching
// is Anthropic-only, so a user override to a non-anthropic/* id on any tier drops caching for that
// tier (byte-identical to pre-#109); an anthropic/* override on any tier keeps it. Setting a custom
// `baseURL` (a non-OpenRouter endpoint) also drops caching — cache_control is an OpenRouter directive.
export const DEFAULT_MODELS: Record<Capability, string> = {
  fast: 'anthropic/claude-haiku-4.5',
  generic: 'anthropic/claude-sonnet-5',
  smart: 'anthropic/claude-opus-5',
  coding: 'anthropic/claude-opus-5',
};

// The provider's default OpenAI-compatible inference endpoint. `baseURL` unset resolves to this
// upstream; the `openrouter` preset (config/provider-presets.ts) sets it explicitly. Single source of
// truth so the preset and the endpoint detector below can never disagree.
export const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';

const OPENROUTER_HOSTNAME = new URL(OPENROUTER_API_BASE_URL).hostname;

// True when the resolved `baseURL` targets OpenRouter — unset/blank means the provider default, which
// IS OpenRouter. Gate OpenRouter-only request directives (cache_control, session_id stickiness, usage
// accounting) on this. A presence check (`!baseURL`) is WRONG: the `openrouter` preset sets baseURL to
// the OpenRouter endpoint explicitly, so a presence check misclassifies every preset-openrouter
// profile as a custom endpoint and silently strips those directives. Compare the HOST instead: the
// exact host or a real subdomain (`gateway.openrouter.ai`), never a lookalike (`notopenrouter.ai`,
// which a bare `endsWith` would accept). A malformed URL fails closed (non-OpenRouter → no
// OpenRouter-only directives). See credentials.ts and loop/run-loop-adapter.ts webSearchProviderOptions.
export function isOpenRouterEndpoint(baseURL: string | undefined): boolean {
  if (baseURL === undefined || baseURL.trim() === '') return true;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === OPENROUTER_HOSTNAME || host.endsWith(`.${OPENROUTER_HOSTNAME}`);
  } catch {
    return false;
  }
}

// Recommended reasoning-effort tiers (issue #125) — DOCUMENTED, not defaulted. Shipping a default
// effort would change request bytes for every existing user and push a `reasoning` param to
// endpoints that may reject it (custom baseURL, non-reasoning models). Opt in via
// `reasoningEffort.<tier>` (see docs/config.md):
//   smart  → high   : plan/review mistakes cost a whole run leg — effort is the cheapest quality lever
//   coding → medium : quality/volume balance on the Worker's editor fanout, the highest-traffic tier
//   fast   → none   : routing/summarization needs no deliberation
//   generic         : unset — effort has no generic-fallback semantics (unlike models.generic)

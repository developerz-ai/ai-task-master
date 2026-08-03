// Typed builders for the two domain shapes the suite hand-rolls most (issue #132).
//
// Both grew required fields after their call sites were written: `AgentConfig` gained `sources`
// (the layered user → project → nested detail), and an `OpenRouterModel` row carries four
// window/limit fields whose values are optional but whose KEYS are not — `z.infer` makes
// `number | undefined` a required property, so a two-key literal is missing three of them.
//
// The tests that hit this care about one field each (a context length, a price, a flavor). These
// state the rest once so a call site says only what it is testing.

import type { AgentConfig } from '../agent-config/agent-config-detector.ts';
import {
  DEFAULT_LLM_STEP_TIMEOUT_MS,
  DEFAULT_MAX_CI_FIX_ATTEMPTS,
  DEFAULT_MCP_DEFER_TOOLS_OVER,
} from '../config/defaults.ts';
import type { ResolvedConfig } from '../config/schema.ts';
import type { OpenRouterModel } from '../openrouter/client.ts';

export function agentConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    flavor: 'claude',
    path: 'CLAUDE.md',
    contents: '# Style\n',
    sources: [],
    ...over,
  };
}

type CatalogPricing = NonNullable<OpenRouterModel['pricing']>;

// What a test actually states about a catalog row: its id, plus whichever window/price field the
// assertion turns on. `pricing` is partial here too — the two cache-price keys are required on the
// real type even when a test sets only the flat prompt/completion pair, and an absent cache price
// is exactly what "degrades to flat pricing" means.
export type CatalogRow = Omit<Partial<OpenRouterModel>, 'pricing'> & {
  id: string;
  pricing?: Partial<CatalogPricing>;
};

export function catalogModel(over: CatalogRow): OpenRouterModel {
  const { pricing, ...rest } = over;
  return {
    context_length: undefined,
    max_completion_tokens: undefined,
    max_model_len: undefined,
    context_window: undefined,
    ...rest,
    ...(pricing === undefined ? {} : { pricing: catalogPricing(pricing) }),
  };
}

export function catalogPricing(over: Partial<CatalogPricing> = {}): CatalogPricing {
  return {
    prompt: undefined,
    completion: undefined,
    input_cache_read: undefined,
    input_cache_write: undefined,
    ...over,
  };
}

// `ResolvedConfig` is the fully-merged run config — every layer collapsed, so almost nothing on it
// is optional. Tests care about two or three knobs each; this states the rest once, reusing the
// real defaults where they exist so a fixture cannot quietly disagree with production.
export function resolvedConfig(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    openrouterApiKey: 'k',
    apiKeySource: 'env',
    models: { generic: 'g', smart: 's', coding: 'c', fast: 'f' },
    reasoningEffort: {},
    maxPrs: 5,
    maxSessions: null,
    maxCiFixAttempts: DEFAULT_MAX_CI_FIX_ATTEMPTS,
    llmStepTimeoutMs: DEFAULT_LLM_STEP_TIMEOUT_MS,
    autoMerge: true,
    prPerTask: false,
    mergeMethod: 'squash',
    stylePath: null,
    formatCommand: null,
    verifyCommand: null,
    selfReview: false,
    resolveConflicts: false,
    generateSpecialists: false,
    logLevel: 'info',
    concurrency: 1,
    subagentLimit: 4,
    allowForcePush: false,
    bashRules: [],
    mcpServers: {},
    mcpDeferToolsOver: DEFAULT_MCP_DEFER_TOOLS_OVER,
    streaming: false,
    mcpServerSources: {},
    ...over,
  };
}

// docs/auth.md, docs/runtime.md, docs/config.md
// Maps subagent role → capability tier → OpenRouter model handle.
// Never reads config files or env directly — that's ConfigLoader's job.
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Subagents", chunk-04.md §"ToolLoopAgent".

import {
  createOpenRouter,
  type OpenRouterChatSettings,
  type OpenRouterProvider,
} from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { Capability, ResolvedConfig } from '../config/schema.ts';
import { DEFAULT_MODELS } from './defaults.ts';

// Amazon Bedrock rejects the AI SDK's structured-output request (`output_config.format`), failing
// the submit-tool-based subagents at random — always excluded (issue #124, originally the point fix).
const ALWAYS_IGNORE_PROVIDER = 'amazon-bedrock';

// Build the OpenRouter chat settings for one call (issues #124, #125, #109). Pure + exported for
// testability, and the single settings-construction path — routing, per-capability fallback models,
// reasoning effort, and prompt caching all compose into this ONE object rather than parallel
// builders. `capability` selects the routing/reasoning/fallback settings (a capability served
// through the model fallback chain still gets that capability's settings). Caching is gated on the
// RESOLVED id AND the endpoint. With nothing configured and a non-Anthropic id the result is
// byte-identical to the historical `{ provider: { ignore: ['amazon-bedrock'] } }`.
export function chatSettings(
  modelId: string,
  capability: Capability,
  resolved: ResolvedConfig,
): OpenRouterChatSettings {
  const routing = resolved.providerRouting;
  const provider: NonNullable<OpenRouterChatSettings['provider']> = {
    // The built-in exclusion is always unioned in (dedup), and stays unconditionally.
    ignore: [...new Set([...(routing?.ignore ?? []), ALWAYS_IGNORE_PROVIDER])],
    ...(routing?.order ? { order: routing.order } : {}),
    ...(routing?.allowFallbacks !== undefined ? { allow_fallbacks: routing.allowFallbacks } : {}),
    ...(routing?.requireParameters !== undefined
      ? { require_parameters: routing.requireParameters }
      : {}),
    ...(routing?.sort ? { sort: routing.sort } : {}),
    ...(routing?.only ? { only: routing.only } : {}),
  };
  const fallback = resolved.fallbackModels?.[capability];
  const effort = resolved.reasoningEffort?.[capability];
  // `cache_control` is an OpenRouter request-body directive enabling Anthropic automatic prompt
  // caching. It only makes sense talking to OpenRouter itself, and only for anthropic/* routes:
  //   - gated on the RESOLVED id, so an anthropic override on any tier is cached and a non-Anthropic
  //     override on a default tier is not;
  //   - suppressed when a custom `baseURL` is set — a self-hosted / z.ai / proxy endpoint is not
  //     OpenRouter and would receive an unknown field, so those requests stay byte-identical (#109
  //     spec bullet 3). TTL unset → provider default 5m; below the min cacheable prefix it is a
  //     silent no-op.
  const cacheable = modelId.startsWith('anthropic/') && !resolved.baseURL;
  return {
    provider,
    ...(fallback !== undefined ? { models: fallback } : {}),
    ...(effort !== undefined ? { reasoning: { effort } } : {}),
    ...(cacheable ? { cache_control: { type: 'ephemeral' as const } } : {}),
  };
}

export type Role = 'planner' | 'worker' | 'reviewer' | 'orchestrator';

export const ROLE_CAPABILITY: Readonly<Record<Role, Capability>> = {
  planner: 'smart',
  worker: 'coding',
  reviewer: 'smart',
  orchestrator: 'fast',
};

export type ModelHandles = Record<Role, LanguageModel>;

// Settings forwarded to the OpenAI-compatible provider: `apiKey` is sent as the Bearer credential to
// `baseURL`. That pairing is safe ONLY because ConfigLoader resolves `baseURL` from user-owned scope
// alone (global/profile config or the OPENROUTER_BASE_URL env) and strips any project-set baseURL —
// so an untrusted target repo can never redirect the key to an attacker host. Do not weaken that
// guarantee by sourcing baseURL from project/repo input. Exported so the passthrough is
// unit-testable without reaching into provider internals. `baseURL` is omitted (not set to
// undefined) when unset so the provider keeps its default — an explicit undefined trips
// exactOptionalPropertyTypes.
export function providerSettings(resolved: ResolvedConfig): { apiKey: string; baseURL?: string } {
  return {
    apiKey: resolved.openrouterApiKey,
    ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
  };
}

export class Credentials {
  // Lazy: provider creation also asserts the API key is present, so callers that
  // only inspect role/capability mapping (tests, dry-run) don't need a real key.
  private providerInstance: OpenRouterProvider | undefined;

  constructor(private readonly resolved: ResolvedConfig) {}

  // Build a handle per role using ROLE_CAPABILITY. Capability fallback chain:
  //   models[capability] → models.generic → built-in default.
  handles(): ModelHandles {
    return {
      planner: this.modelFor('planner'),
      worker: this.modelFor('worker'),
      reviewer: this.modelFor('reviewer'),
      orchestrator: this.modelFor('orchestrator'),
    };
  }

  modelFor(role: Role): LanguageModel {
    return this.modelForCapability(ROLE_CAPABILITY[role]);
  }

  modelForCapability(capability: Capability): LanguageModel {
    const modelId = this.modelIdForCapability(capability);
    return this.provider().chat(modelId, chatSettings(modelId, capability, this.resolved));
  }

  // The resolved model *id string* for a capability tier, via the same fallback chain
  // modelForCapability uses: models[capability] → models.generic → built-in default. Callers that
  // need the id (e.g. the Compactor's context-window lookup, issue #102) use this instead of
  // reaching into the provider handle's internals.
  modelIdForCapability(capability: Capability): string {
    return (
      this.resolved.models[capability] || this.resolved.models.generic || DEFAULT_MODELS[capability]
    );
  }

  // Role-keyed sugar over modelIdForCapability, mirroring modelFor(role).
  modelIdFor(role: Role): string {
    return this.modelIdForCapability(ROLE_CAPABILITY[role]);
  }

  // Lets CLI fail fast before any LLM call (docs/commands/start.md §Preconditions step 2).
  static assertApiKeyPresent(resolved: ResolvedConfig): void {
    if (!resolved.openrouterApiKey || resolved.openrouterApiKey.trim() === '') {
      throw new Error(
        'OPENROUTER_API_KEY is missing. Set OPENROUTER_API_KEY in the environment, or run `aitm config set openrouterApiKey <key>` (get one at https://openrouter.ai/keys).',
      );
    }
  }

  private provider(): OpenRouterProvider {
    if (!this.providerInstance) {
      Credentials.assertApiKeyPresent(this.resolved);
      this.providerInstance = createOpenRouter(providerSettings(this.resolved));
    }
    return this.providerInstance;
  }
}

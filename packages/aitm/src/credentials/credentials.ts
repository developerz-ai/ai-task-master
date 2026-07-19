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

// Model families that honour an explicit `cache_control` breakpoint through OpenRouter: Anthropic
// automatic caching, plus Qwen/Alibaba per OpenRouter's caching docs. Every other family relies on
// the provider's automatic upstream caching, so no directive is sent.
const CACHE_CONTROL_FAMILIES = ['anthropic/', 'qwen/', 'alibaba/'] as const;

function usesCacheControl(modelId: string): boolean {
  return CACHE_CONTROL_FAMILIES.some((family) => modelId.startsWith(family));
}

// Build the OpenRouter chat settings for one call (issues #124, #125, #109; plan slice 04a). Pure +
// exported for testability, and the single settings-construction path — routing, per-capability
// fallback models, reasoning effort, prompt caching, and session stickiness all compose into this
// ONE object rather than parallel builders. `capability` selects the routing/reasoning/fallback
// settings (a capability served through the model fallback chain still gets that capability's
// settings). Caching is gated on the RESOLVED id AND the endpoint. `sessionId` (the run-scoped
// runId) adds sticky-routing / prompt-cache-key hints per provider family. With nothing configured,
// a non-cache-control id, and no sessionId the result is byte-identical to the historical
// `{ provider: { ignore: ['amazon-bedrock'] } }`.
export function chatSettings(
  modelId: string,
  capability: Capability,
  resolved: ResolvedConfig,
  sessionId?: string,
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
  // A custom `baseURL` (z.ai, moonshot, self-hosted, proxy) is a direct OpenAI-compatible endpoint,
  // not OpenRouter — it must not receive OpenRouter-only directives.
  const onOpenRouter = !resolved.baseURL;
  // `cache_control` is an OpenRouter request-body directive enabling automatic prompt caching for
  // the cache-control families (anthropic/*, qwen/*, alibaba/*):
  //   - gated on the RESOLVED id, so a cache-control override on any tier is cached and a
  //     non-cache-control override on a default tier is not;
  //   - suppressed on a custom `baseURL` (#109 spec bullet 3) — those requests stay byte-identical.
  //     TTL unset → provider default 5m; below the min cacheable prefix it is a silent no-op.
  const cacheable = usesCacheControl(modelId) && onOpenRouter;
  // Session stickiness + implicit prompt-cache key. `session_id` is an OpenRouter routing hint (keeps
  // a conversation on one upstream provider → warmer cache); `prompt_cache_key` is the OpenAI-family
  // cache key. OpenRouter route → both; a direct OpenAI-compatible baseURL → `prompt_cache_key` only.
  // Carried via `extraBody`, which the provider spreads verbatim onto the top-level request body.
  const sessionBody = sessionId
    ? onOpenRouter
      ? { session_id: sessionId, prompt_cache_key: sessionId }
      : { prompt_cache_key: sessionId }
    : undefined;
  return {
    provider,
    ...(fallback !== undefined ? { models: fallback } : {}),
    ...(effort !== undefined ? { reasoning: { effort } } : {}),
    ...(cacheable ? { cache_control: { type: 'ephemeral' as const } } : {}),
    ...(sessionBody ? { extraBody: sessionBody } : {}),
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
// exactOptionalPropertyTypes. `fetchImpl` is the keep-alive transport (createLlmFetch); it is
// likewise omitted when absent (off-Node / undici unavailable) so the provider keeps its default
// fetch and the request path stays byte-identical.
export function providerSettings(
  resolved: ResolvedConfig,
  fetchImpl?: typeof fetch,
): { apiKey: string; baseURL?: string; fetch?: typeof fetch } {
  return {
    apiKey: resolved.openrouterApiKey,
    ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
}

export class Credentials {
  // Lazy: provider creation also asserts the API key is present, so callers that
  // only inspect role/capability mapping (tests, dry-run) don't need a real key.
  private providerInstance: OpenRouterProvider | undefined;

  // `sessionId` is the run-scoped id (state.runId): reused across every role/stage in a run and
  // preserved on resume, so session stickiness + prompt-cache keys stay stable per conversation.
  // `fetchImpl` is the keep-alive transport (createLlmFetch), injected once at the CLI boundary
  // where an async factory can run; undefined keeps the provider's default fetch.
  constructor(
    private readonly resolved: ResolvedConfig,
    private readonly sessionId?: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

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
    return this.provider().chat(
      modelId,
      chatSettings(modelId, capability, this.resolved, this.sessionId),
    );
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
      this.providerInstance = createOpenRouter(providerSettings(this.resolved, this.fetchImpl));
    }
    return this.providerInstance;
  }
}

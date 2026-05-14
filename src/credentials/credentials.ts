// docs/auth.md, docs/runtime.md, docs/config.md
// Maps subagent role → capability tier → OpenRouter model handle.
// Never reads config files or env directly — that's ConfigLoader's job.
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Subagents", chunk-04.md §"ToolLoopAgent".

import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { Capability, ResolvedConfig } from '../config/schema.ts';
import { DEFAULT_MODELS } from './defaults.ts';

export type Role = 'planner' | 'worker' | 'reviewer' | 'orchestrator';

export const ROLE_CAPABILITY: Readonly<Record<Role, Capability>> = {
  planner: 'smart',
  worker: 'coding',
  reviewer: 'smart',
  orchestrator: 'fast',
};

export type ModelHandles = Record<Role, LanguageModel>;

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
    const modelId =
      this.resolved.models[capability] ||
      this.resolved.models.generic ||
      DEFAULT_MODELS[capability];
    return this.provider().chat(modelId);
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
      this.providerInstance = createOpenRouter({ apiKey: this.resolved.openrouterApiKey });
    }
    return this.providerInstance;
  }
}

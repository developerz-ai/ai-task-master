// docs/auth.md, docs/runtime.md, docs/config.md
// Maps subagent role → capability tier → OpenRouter model handle.
// Never reads config files or env directly — that's ConfigLoader's job.
// SDK reference: docs/vendor/ai-sdk/chunk-09.md §"Subagents", chunk-04.md §"ToolLoopAgent".

import type { LanguageModel } from 'ai';
import type { Capability, ResolvedConfig } from '../config/schema.ts';

export type Role = 'planner' | 'worker' | 'reviewer' | 'orchestrator';

export const ROLE_CAPABILITY: Readonly<Record<Role, Capability>> = {
  planner: 'smart',
  worker: 'coding',
  reviewer: 'smart',
  orchestrator: 'fast',
};

export type ModelHandles = Record<Role, LanguageModel>;

export class Credentials {
  constructor(private readonly resolved: ResolvedConfig) {}

  // Build a handle per role using ROLE_CAPABILITY. Capability fallback chain:
  //   models[capability] → models.generic → built-in default.
  handles(): ModelHandles {
    throw new Error('not implemented');
  }

  modelFor(_role: Role): LanguageModel {
    throw new Error('not implemented');
  }

  modelForCapability(_capability: Capability): LanguageModel {
    throw new Error('not implemented');
  }

  // Lets CLI fail fast before any LLM call (docs/commands/start.md §Preconditions step 2).
  static assertApiKeyPresent(_resolved: ResolvedConfig): void {
    throw new Error('not implemented');
  }
}

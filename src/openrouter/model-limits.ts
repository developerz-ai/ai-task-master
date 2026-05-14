// Exposes per-model limits (context window, pricing hints) used by the Compactor.
// Cached per-run after first fetch — model catalog changes slowly.
// docs/auth.md, src/compaction/compactor.ts

import type { OpenRouterClient } from './client.ts';

export type ModelLimits = {
  modelId: string;
  contextLength: number;
};

export class ModelNotFound extends Error {
  override readonly name = 'ModelNotFound';
  constructor(public readonly modelId: string) {
    super(`Model not found in OpenRouter catalog: ${modelId}`);
  }
}

export class ModelLimitsRegistry {
  private cache: Map<string, ModelLimits> | undefined;

  constructor(private readonly client: OpenRouterClient) {}

  async forModel(modelId: string): Promise<ModelLimits> {
    if (!this.cache) {
      await this.preload();
    }
    const hit = this.cache?.get(modelId);
    if (!hit) {
      throw new ModelNotFound(modelId);
    }
    return hit;
  }

  async preload(): Promise<void> {
    if (this.cache) return;
    const models = await this.client.listModels();
    const next = new Map<string, ModelLimits>();
    for (const m of models) {
      next.set(m.id, { modelId: m.id, contextLength: m.context_length });
    }
    this.cache = next;
  }
}

// Exposes per-model limits (context window, pricing hints) used by the Compactor.
// Cached per-run after first fetch — model catalog changes slowly.
// docs/auth.md, src/compaction/compactor.ts

import type { OpenRouterClient } from './client.ts';

export type ModelLimits = {
  modelId: string;
  contextLength: number;
};

export class ModelLimitsRegistry {
  constructor(private readonly client: OpenRouterClient) {}

  // Populated on first call to forModel(); subsequent calls hit the in-memory cache.
  async forModel(_modelId: string): Promise<ModelLimits> {
    throw new Error('not implemented');
  }

  // Optional pre-warm: fetch catalog once before any agent runs.
  async preload(): Promise<void> {
    throw new Error('not implemented');
  }
}

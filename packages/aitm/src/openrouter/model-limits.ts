// Exposes per-model limits (context window, pricing hints) used by the Compactor.
// Cached per-run after first fetch — model catalog changes slowly.
// docs/auth.md, src/compaction/compactor.ts

import type { OpenRouterClient } from './client.ts';

export type ModelLimits = {
  modelId: string;
  contextLength: number;
  // Per-token USD, parsed from the catalog pricing strings (issue #114). Undefined when the catalog
  // omits the field; consumers degrade cost to `null` rather than guessing. `cacheRead`/`cacheWrite`
  // price cached prompt tokens (issue #114 amendment) — absent → fall back to `promptUsdPerToken`.
  promptUsdPerToken?: number;
  completionUsdPerToken?: number;
  cacheReadUsdPerToken?: number;
  cacheWriteUsdPerToken?: number;
};

// Parse a catalog per-token USD string ("0.000005") to a number; undefined/blank/non-finite →
// undefined. The blank guard is load-bearing: `Number('')` and whitespace-only strings are `0` in
// JS, which would masquerade a missing price as $0/token instead of "unknown".
function parsePrice(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// Structural view of the registry used by the Compactor and its tests. The class
// implements this so test stubs can `satisfies ModelLimitsLookup` without casts.
export type ModelLimitsLookup = {
  forModel(modelId: string): Promise<ModelLimits>;
  preload(): Promise<void>;
};

export class ModelNotFound extends Error {
  override readonly name = 'ModelNotFound';
  constructor(public readonly modelId: string) {
    super(`Model not found in OpenRouter catalog: ${modelId}`);
  }
}

export class ModelLimitsRegistry implements ModelLimitsLookup {
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
      const promptUsdPerToken = parsePrice(m.pricing?.prompt);
      const completionUsdPerToken = parsePrice(m.pricing?.completion);
      const cacheReadUsdPerToken = parsePrice(m.pricing?.input_cache_read);
      const cacheWriteUsdPerToken = parsePrice(m.pricing?.input_cache_write);
      next.set(m.id, {
        modelId: m.id,
        contextLength: m.context_length,
        // Omit undefined keys rather than storing undefined (exactOptionalPropertyTypes).
        ...(promptUsdPerToken !== undefined ? { promptUsdPerToken } : {}),
        ...(completionUsdPerToken !== undefined ? { completionUsdPerToken } : {}),
        ...(cacheReadUsdPerToken !== undefined ? { cacheReadUsdPerToken } : {}),
        ...(cacheWriteUsdPerToken !== undefined ? { cacheWriteUsdPerToken } : {}),
      });
    }
    this.cache = next;
  }
}

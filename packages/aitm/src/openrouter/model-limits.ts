// Exposes per-model limits (context window, pricing hints) used by the Compactor.
// Cached per-run after first fetch — model catalog changes slowly.
// docs/auth.md, src/compaction/compactor.ts
//
// Two sources, in precedence order. The active provider's own `/models` is authoritative. Whatever it
// omits is filled from OpenRouter's public catalog (reference-catalog.ts), because a subscription
// gateway routinely publishes an id and nothing else — measured: z.ai's coding endpoint publishes no
// window and no pricing at all, which left the Compactor permanently inert (it will not compact a
// model whose window it does not know) and every run's cost unknown. Reference-sourced values are
// tagged so the CLI can render them as list-price estimates rather than as what the run was billed.

import {
  contextLengthOf,
  maxOutputTokensOf,
  type OpenRouterClient,
  type OpenRouterModel,
} from './client.ts';
import { matchReferenceModel, type ReferenceCatalogClient } from './reference-catalog.ts';

// Minimal catalog contract the registry actually needs — lets stubs (and any narrower client) pass
// without an `as unknown as OpenRouterClient` cast at the constructor boundary.
export type ModelCatalogClient = Pick<OpenRouterClient, 'listModels'>;

// Where a resolved value came from. `provider` is the endpoint aitm actually calls; `reference` is
// OpenRouter's public catalog, which prices a comparable model at LIST rates — not what a
// subscription charged.
export type LimitSource = 'provider' | 'reference';

export type ModelLimits = {
  modelId: string;
  // Undefined when neither source publishes a window for this model. Consumers skip rather than
  // guess: the Compactor does not compact a model whose window it doesn't know, exactly as it treats
  // a non-finite one.
  contextLength?: number;
  // The most the model may emit in one reply. Input and output share the window, so this is the
  // slice of it that cannot hold conversation — the Compactor reserves it. Undefined when neither
  // source publishes one.
  maxOutputTokens?: number;
  // Per-token USD, parsed from the catalog pricing strings (issue #114). Undefined when neither
  // source carries pricing; consumers degrade cost to `null` rather than guessing. `cacheRead`/
  // `cacheWrite` price cached prompt tokens (issue #114 amendment) — absent → fall back to
  // `promptUsdPerToken`.
  promptUsdPerToken?: number;
  completionUsdPerToken?: number;
  cacheReadUsdPerToken?: number;
  cacheWriteUsdPerToken?: number;
  // Set only alongside the value they describe. `pricingSource: 'reference'` is what makes a cost
  // figure an estimate; the CLI must say so rather than print it as billed.
  contextSource?: LimitSource;
  pricingSource?: LimitSource;
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
  private loadPromise: Promise<void> | undefined;

  // `reference` is optional so every existing construction site and test stub keeps working; without
  // it the registry behaves exactly as it did before the reference book existed.
  constructor(
    private readonly client: ModelCatalogClient,
    private readonly reference?: ReferenceCatalogClient,
  ) {}

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

  // Every model the provider's catalog lists, resolved. Feeds the startup banner, which prints the
  // window and price aitm will actually run with — including which of them are list-price estimates.
  async all(): Promise<ModelLimits[]> {
    if (!this.cache) await this.preload();
    return [...(this.cache?.values() ?? [])];
  }

  async preload(): Promise<void> {
    if (this.cache) return;
    if (this.loadPromise) return this.loadPromise;
    // Clear the in-flight promise on failure so a transient catalog error (network/HTTP/schema)
    // doesn't wedge every later preload()/forModel() call on a permanently-rejected promise.
    // Concurrent callers still share this promise and see the same rejection.
    const loadPromise = this.load();
    this.loadPromise = loadPromise.catch((error: unknown) => {
      this.loadPromise = undefined;
      throw error;
    });
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    const models = await this.client.listModels();
    const next = new Map<string, ModelLimits>();
    for (const m of models) {
      next.set(m.id, limitsOf(m, m.id, 'provider'));
    }
    this.cache = next;
    await this.fillFromReference(next);
  }

  // Fill what the provider's catalog left blank. Skipped entirely when nothing is missing (a native
  // OpenRouter profile), so the common case pays no extra request. Failure is swallowed on purpose:
  // the reference book is an enhancement, and a run must not die because a third-party catalog was
  // unreachable — the fields simply stay undefined, exactly as before.
  private async fillFromReference(cache: Map<string, ModelLimits>): Promise<void> {
    if (!this.reference) return;
    const gaps = [...cache.values()].filter(hasGap);
    if (gaps.length === 0) return;
    let reference: readonly OpenRouterModel[];
    try {
      reference = await this.reference.listModels();
    } catch {
      return;
    }
    for (const entry of gaps) {
      const match = matchReferenceModel(entry.modelId, reference);
      if (!match) continue;
      cache.set(entry.modelId, merge(entry, limitsOf(match, entry.modelId, 'reference')));
    }
  }
}

// A resolved entry still missing something the reference book could supply.
function hasGap(limits: ModelLimits): boolean {
  return (
    limits.contextLength === undefined ||
    limits.maxOutputTokens === undefined ||
    limits.promptUsdPerToken === undefined ||
    limits.completionUsdPerToken === undefined
  );
}

// Project one catalog entry onto ModelLimits under `modelId` (which is the LOCAL id, not the
// reference entry's org-qualified one), tagging each group of fields with where it came from.
// Undefined keys are omitted rather than stored as undefined (exactOptionalPropertyTypes).
function limitsOf(model: OpenRouterModel, modelId: string, source: LimitSource): ModelLimits {
  const contextLength = contextLengthOf(model);
  const maxOutputTokens = maxOutputTokensOf(model);
  const promptUsdPerToken = parsePrice(model.pricing?.prompt);
  const completionUsdPerToken = parsePrice(model.pricing?.completion);
  const cacheReadUsdPerToken = parsePrice(model.pricing?.input_cache_read);
  const cacheWriteUsdPerToken = parsePrice(model.pricing?.input_cache_write);
  return {
    modelId,
    ...(contextLength !== undefined ? { contextLength, contextSource: source } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(promptUsdPerToken !== undefined ? { promptUsdPerToken, pricingSource: source } : {}),
    ...(completionUsdPerToken !== undefined
      ? { completionUsdPerToken, pricingSource: source }
      : {}),
    ...(cacheReadUsdPerToken !== undefined ? { cacheReadUsdPerToken } : {}),
    ...(cacheWriteUsdPerToken !== undefined ? { cacheWriteUsdPerToken } : {}),
  };
}

// `base` wins on every field it already has — the provider aitm actually calls is authoritative, and
// a partially-published catalog (kimi publishes a window but no pricing) keeps its own window while
// borrowing only the missing prices.
//
// Pricing moves as one group, never field-by-field: a rate sheet is internally consistent, and
// pairing a provider's prompt rate with OpenRouter's completion rate would produce a number that is
// true of no actual price list. Either the provider published both halves and we use them, or the
// reference book supplies both and the result is flagged an estimate.
function merge(base: ModelLimits, fill: ModelLimits): ModelLimits {
  const out: ModelLimits = { ...base };
  if (out.contextLength === undefined && fill.contextLength !== undefined) {
    out.contextLength = fill.contextLength;
    if (fill.contextSource !== undefined) out.contextSource = fill.contextSource;
  }
  if (out.maxOutputTokens === undefined && fill.maxOutputTokens !== undefined) {
    out.maxOutputTokens = fill.maxOutputTokens;
  }
  const basePriced =
    base.promptUsdPerToken !== undefined && base.completionUsdPerToken !== undefined;
  const prompt = fill.promptUsdPerToken;
  const completion = fill.completionUsdPerToken;
  if (!basePriced && prompt !== undefined && completion !== undefined) {
    out.promptUsdPerToken = prompt;
    out.completionUsdPerToken = completion;
    if (fill.cacheReadUsdPerToken !== undefined) {
      out.cacheReadUsdPerToken = fill.cacheReadUsdPerToken;
    } else {
      delete out.cacheReadUsdPerToken;
    }
    if (fill.cacheWriteUsdPerToken !== undefined) {
      out.cacheWriteUsdPerToken = fill.cacheWriteUsdPerToken;
    } else {
      delete out.cacheWriteUsdPerToken;
    }
    if (fill.pricingSource !== undefined) out.pricingSource = fill.pricingSource;
  }
  return out;
}

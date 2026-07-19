// Per-run token-usage + cost accounting (issue #114). Sibling of error-reporter.ts and held to the
// same stance: observability must never break a run. `record` is a synchronous fire-and-forget
// accumulation keyed by role + model id; `totals()` prices once at flush time through an injected
// ModelLimitsLookup (one lazy /models fetch). Any unknown model, missing pricing field, or catalog
// fetch failure still reports tokens and degrades cost to `null` — never a throw.
// docs/auth.md §"LLM provider", src/observability/error-reporter.ts

import type { LanguageModelUsage, ProviderMetadata } from 'ai';
import type { Role } from '../credentials/credentials.ts';
import type { ModelLimits, ModelLimitsLookup } from '../openrouter/model-limits.ts';

export type RoleUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  // Cache-write (cache-creation) input tokens, from `inputTokenDetails.cacheWriteTokens` when the
  // provider reports it (e.g. Anthropic families via OpenRouter). Informational only — not priced;
  // the amendment's cost formula bills cache writes at the prompt rate (costForModel below).
  cacheWriteInputTokens: number;
  calls: number;
  // null when pricing was unknown for any recorded call (unknown model, missing pricing, or a failed
  // catalog fetch). Tokens are still reported.
  costUsd: number | null;
  // Provider-reported dollar saving from cache reads (OpenRouter `usage.cache_discount`, sent when
  // `usage: { include: true }` is set — credentials.ts chatSettings). null when no recorded call ever
  // reported one (not an error state, unlike costUsd — the provider simply may not echo it).
  cacheDiscountUsd: number | null;
};

export type UsageTotals = {
  perRole: Partial<Record<Role, RoleUsage>>;
  overall: RoleUsage;
};

// Token accumulation for one (role, model id) bucket; priced per model at flush time.
type Accumulation = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  calls: number;
  cacheDiscountUsd: number | null;
};

// A record whose model id could not be determined — cannot be priced (cost degrades to null).
const UNKNOWN_MODEL = '';

function newAccumulation(): Accumulation {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    calls: 0,
    cacheDiscountUsd: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Pull OpenRouter's `cache_discount` out of a generate result's providerMetadata, when the endpoint
// echoed it (requires `usage: { include: true }`, wired in credentials.ts chatSettings). Not part of
// the AI SDK's `LanguageModelUsage` — this is the "channel beyond LanguageModelUsage" the plan calls
// for. Accepts both the SDK's camelCase convention and the raw API's snake_case, since the installed
// @openrouter/ai-sdk-provider version does not yet forward this field either way — defensive/forward
// compatible, never throws on an unexpected shape.
function extractCacheDiscountUsd(
  providerMetadata: ProviderMetadata | undefined,
): number | undefined {
  const openrouter = providerMetadata?.openrouter;
  if (!isRecord(openrouter)) return undefined;
  const usage = openrouter.usage;
  if (!isRecord(usage)) return undefined;
  const discount = usage.cacheDiscount ?? usage.cache_discount;
  return typeof discount === 'number' ? discount : undefined;
}

// Cache-aware cost for one model's tokens (issue #114 + amendment). Non-cached input bills at
// `prompt`, cache-read input at `input_cache_read` (falling back to `prompt` when the catalog omits
// it), output at `completion`. Missing prompt/completion pricing → null (cost unknown). Cache-write
// premium is deliberately not modelled — the amendment's formula prices writes at the prompt rate.
function costForModel(limits: ModelLimits, acc: Accumulation): number | null {
  const { promptUsdPerToken, completionUsdPerToken } = limits;
  if (promptUsdPerToken === undefined || completionUsdPerToken === undefined) return null;
  const cacheReadRate = limits.cacheReadUsdPerToken ?? promptUsdPerToken;
  const nonCachedInput = Math.max(0, acc.inputTokens - acc.cachedInputTokens);
  return (
    nonCachedInput * promptUsdPerToken +
    acc.cachedInputTokens * cacheReadRate +
    acc.outputTokens * completionUsdPerToken
  );
}

export class UsageTracker {
  // role → (model id → tokens). Per-model so totals() can price each model, then sum per role.
  private readonly byRole = new Map<Role, Map<string, Accumulation>>();

  constructor(private readonly limits: ModelLimitsLookup) {}

  // Accumulate one generate call's usage. Synchronous and never throws. Pass the result's
  // `totalUsage` (all steps), `response.modelId` (when unknown the caller should fall back to the
  // role's configured model id, else this bucket cannot be priced), and its `providerMetadata` (issue
  // #114 amendment, slice 04b) — the optional cache_discount channel; omitted callers just don't
  // report one.
  record(
    role: Role,
    modelId: string | undefined,
    usage: LanguageModelUsage,
    providerMetadata?: ProviderMetadata,
  ): void {
    const key = modelId ?? UNKNOWN_MODEL;
    const models = this.byRole.get(role) ?? new Map<string, Accumulation>();
    const acc = models.get(key) ?? newAccumulation();
    acc.inputTokens += usage.inputTokens ?? 0;
    acc.outputTokens += usage.outputTokens ?? 0;
    acc.cachedInputTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
    acc.cacheWriteInputTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    acc.calls += 1;
    const discount = extractCacheDiscountUsd(providerMetadata);
    if (discount !== undefined) acc.cacheDiscountUsd = (acc.cacheDiscountUsd ?? 0) + discount;
    models.set(key, acc);
    this.byRole.set(role, models);
  }

  // Sum tokens per role + overall and price each model through the lookup. One lazy /models fetch.
  async totals(): Promise<UsageTotals> {
    const perRole: Partial<Record<Role, RoleUsage>> = {};
    const overall: RoleUsage = { ...newAccumulation(), costUsd: 0 };
    for (const [role, models] of this.byRole) {
      const roleUsage: RoleUsage = { ...newAccumulation(), costUsd: 0 };
      for (const [modelId, acc] of models) {
        roleUsage.inputTokens += acc.inputTokens;
        roleUsage.outputTokens += acc.outputTokens;
        roleUsage.cachedInputTokens += acc.cachedInputTokens;
        roleUsage.cacheWriteInputTokens += acc.cacheWriteInputTokens;
        roleUsage.calls += acc.calls;
        const cost = await this.costFor(modelId, acc);
        if (cost === null) roleUsage.costUsd = null;
        else if (roleUsage.costUsd !== null) roleUsage.costUsd += cost;
        if (acc.cacheDiscountUsd !== null) {
          roleUsage.cacheDiscountUsd = (roleUsage.cacheDiscountUsd ?? 0) + acc.cacheDiscountUsd;
        }
      }
      perRole[role] = roleUsage;
      overall.inputTokens += roleUsage.inputTokens;
      overall.outputTokens += roleUsage.outputTokens;
      overall.cachedInputTokens += roleUsage.cachedInputTokens;
      overall.cacheWriteInputTokens += roleUsage.cacheWriteInputTokens;
      overall.calls += roleUsage.calls;
      if (roleUsage.costUsd === null) overall.costUsd = null;
      else if (overall.costUsd !== null) overall.costUsd += roleUsage.costUsd;
      if (roleUsage.cacheDiscountUsd !== null) {
        overall.cacheDiscountUsd = (overall.cacheDiscountUsd ?? 0) + roleUsage.cacheDiscountUsd;
      }
    }
    return { perRole, overall };
  }

  private async costFor(modelId: string, acc: Accumulation): Promise<number | null> {
    if (modelId === UNKNOWN_MODEL) return null;
    try {
      return costForModel(await this.limits.forModel(modelId), acc);
    } catch {
      // ModelNotFound, or a failed catalog fetch/parse — tokens still reported, cost unknown.
      return null;
    }
  }
}

// Bind a tracker to one role for the `onUsage` seam: records under `role`, falling back to the role's
// configured model id when the provider did not echo one. Returns undefined when there is no tracker,
// so callers omit the seam entirely. The return shape is structurally the factory's `OnUsage`.
export function roleUsageSink(
  tracker: UsageTracker | undefined,
  role: Role,
  fallbackModelId: string,
):
  | ((
      usage: LanguageModelUsage,
      modelId: string | undefined,
      providerMetadata?: ProviderMetadata,
    ) => void)
  | undefined {
  if (!tracker) return undefined;
  return (usage, modelId, providerMetadata) =>
    tracker.record(role, modelId ?? fallbackModelId, usage, providerMetadata);
}

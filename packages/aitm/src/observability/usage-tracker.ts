// Per-run token-usage + cost accounting (issue #114). Sibling of error-reporter.ts and held to the
// same stance: observability must never break a run. `record` is a synchronous fire-and-forget
// accumulation keyed by role + model id; `totals()` prices once at flush time through an injected
// ModelLimitsLookup (one lazy /models fetch). Any unknown model, missing pricing field, or catalog
// fetch failure still reports tokens and degrades cost to `null` — never a throw.
// docs/auth.md §"LLM provider", src/observability/error-reporter.ts

import type { LanguageModelUsage } from 'ai';
import type { Role } from '../credentials/credentials.ts';
import type { ModelLimits, ModelLimitsLookup } from '../openrouter/model-limits.ts';

export type RoleUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  calls: number;
  // null when pricing was unknown for any recorded call (unknown model, missing pricing, or a failed
  // catalog fetch). Tokens are still reported.
  costUsd: number | null;
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
  calls: number;
};

// A record whose model id could not be determined — cannot be priced (cost degrades to null).
const UNKNOWN_MODEL = '';

function newAccumulation(): Accumulation {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 };
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
  // `totalUsage` (all steps) and `response.modelId`; when the id is unknown the caller should fall
  // back to the role's configured model id, else this bucket cannot be priced.
  record(role: Role, modelId: string | undefined, usage: LanguageModelUsage): void {
    const key = modelId ?? UNKNOWN_MODEL;
    const models = this.byRole.get(role) ?? new Map<string, Accumulation>();
    const acc = models.get(key) ?? newAccumulation();
    acc.inputTokens += usage.inputTokens ?? 0;
    acc.outputTokens += usage.outputTokens ?? 0;
    acc.cachedInputTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0;
    acc.calls += 1;
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
        roleUsage.calls += acc.calls;
        const cost = await this.costFor(modelId, acc);
        if (cost === null) roleUsage.costUsd = null;
        else if (roleUsage.costUsd !== null) roleUsage.costUsd += cost;
      }
      perRole[role] = roleUsage;
      overall.inputTokens += roleUsage.inputTokens;
      overall.outputTokens += roleUsage.outputTokens;
      overall.cachedInputTokens += roleUsage.cachedInputTokens;
      overall.calls += roleUsage.calls;
      if (roleUsage.costUsd === null) overall.costUsd = null;
      else if (overall.costUsd !== null) overall.costUsd += roleUsage.costUsd;
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
): ((usage: LanguageModelUsage, modelId: string | undefined) => void) | undefined {
  if (!tracker) return undefined;
  return (usage, modelId) => tracker.record(role, modelId ?? fallbackModelId, usage);
}

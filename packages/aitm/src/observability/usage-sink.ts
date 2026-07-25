// A subagent-usage sink (issue #114) and its fire-and-forget dispatcher. Leaf module: no imports
// from subagents/ or loop/, so agent-config/, subagents/, loop/, and orchestrator/ can all depend
// on it without any of them importing the others just for this callback shape.

import type { LanguageModelUsage, ProviderMetadata } from 'ai';

// Fired once per generate call with the result's `totalUsage` (all steps), `response.modelId`, and
// the result's `providerMetadata` (issue #114 amendment, slice 04b) — the channel a
// provider-reported `cache_discount`/cache-write rides beyond what `LanguageModelUsage` carries.
// Fire-and-forget: a recording error must never break the run, so the accumulation side
// (UsageTracker.record) swallows and this stays a plain void callback.
export type OnUsage = (
  usage: LanguageModelUsage,
  modelId: string | undefined,
  providerMetadata?: ProviderMetadata,
  // Per-generate diagnostics (issue #168): wall-clock for this call and how many corrective
  // re-generations preceded it. Optional — a call site that doesn't measure them omits it.
  meta?: { latencyMs?: number; retries?: number },
) => void;

// Feed a generate result's total usage + resolved model id + provider metadata to an optional sink
// (issue #114, slice 04b). For the direct generateText / agent.generate call sites (worker editor +
// manifest, orchestrator, style distiller); the schema-retry path meters inside compat.
// Fire-and-forget — never breaks the run.
export function reportUsage(
  onUsage: OnUsage | undefined,
  result: {
    totalUsage: LanguageModelUsage;
    response: { modelId: string };
    providerMetadata?: ProviderMetadata | undefined;
  },
  meta?: { latencyMs?: number; retries?: number },
): void {
  if (!onUsage) return;
  try {
    onUsage(result.totalUsage, result.response.modelId, result.providerMetadata, meta);
  } catch {
    // observability must never break the run
  }
}

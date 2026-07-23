// The one-time startup banner: what every configured model's context window and price actually
// resolved to, and where those numbers came from.
//
// This is diagnostic, not decorative. A provider that publishes no context window silently disables
// autocompaction for the whole run (the Compactor will not compact a window it doesn't know), and a
// provider that publishes no pricing silently reduces the end-of-run summary to `cost unknown`. Both
// were invisible until the run was over. Printed once at start, they are visible before any tokens
// are spent.
//
// SRP: formatting only. ModelLimitsRegistry resolves the numbers; commands.ts prints the string.

import type { ModelLimits } from '../openrouter/model-limits.ts';

export type BannerEntry = {
  // The capability slot this model is wired to: generic / smart / coding / fast.
  capability: string;
  modelId: string;
  // Undefined when the model resolved to nothing at all — neither catalog lists it.
  limits: ModelLimits | undefined;
};

// Tokens as a short human figure: 1048576 → `1.0M`, 202752 → `202.8K`.
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

// Per-token USD as dollars per million tokens — the unit every provider quotes and the only one a
// human can compare at a glance. Sub-cent rates keep enough precision to stay distinguishable.
export function formatRate(usdPerToken: number): string {
  const perMillion = usdPerToken * 1_000_000;
  const digits = perMillion < 1 ? 3 : 2;
  return `$${perMillion.toFixed(digits)}/M`;
}

function pricePart(limits: ModelLimits): string {
  const { promptUsdPerToken, completionUsdPerToken, cacheReadUsdPerToken } = limits;
  if (promptUsdPerToken === undefined || completionUsdPerToken === undefined) {
    return 'price unknown';
  }
  const parts = [`in ${formatRate(promptUsdPerToken)}`, `out ${formatRate(completionUsdPerToken)}`];
  if (cacheReadUsdPerToken !== undefined) parts.push(`cached ${formatRate(cacheReadUsdPerToken)}`);
  return parts.join(' · ');
}

// The window, or the consequence of not having one. Saying "autocompaction off" here is the whole
// point of the banner: it is the difference between a long run that compacts and one that walks into
// a context-overflow error with no warning.
function contextPart(limits: ModelLimits | undefined): string {
  const window = limits?.contextLength;
  if (window === undefined) return 'window unknown — autocompaction off';
  return `${formatTokens(window)} ctx`;
}

// Where the numbers came from, when it isn't the provider itself. A reference-sourced price is a
// LIST price for a comparable model — the run is billed by whatever the configured endpoint charges
// (often a flat subscription), so this must never read as the amount charged.
function sourcePart(limits: ModelLimits | undefined): string {
  if (!limits) return '';
  const borrowed: string[] = [];
  if (limits.contextSource === 'reference') borrowed.push('window');
  if (limits.pricingSource === 'reference') borrowed.push('price');
  if (borrowed.length === 0) return '';
  return `(${borrowed.join(' + ')} from OpenRouter list — your endpoint publishes none)`;
}

// One line per distinct model, with the capabilities it serves collapsed onto it: generic/smart/
// coding usually point at the same id, and three identical lines is noise, not information.
function collapse(entries: readonly BannerEntry[]): BannerEntry[] {
  const byModel = new Map<string, { caps: string[]; limits: ModelLimits | undefined }>();
  for (const entry of entries) {
    const hit = byModel.get(entry.modelId);
    if (hit) hit.caps.push(entry.capability);
    else byModel.set(entry.modelId, { caps: [entry.capability], limits: entry.limits });
  }
  return [...byModel.entries()].map(([modelId, { caps, limits }]) => ({
    capability: caps.join(', '),
    modelId,
    limits,
  }));
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

// The full banner, or '' when there is nothing to say (no configured models). `heading` names the
// provider the numbers describe — the active profile and its base URL.
export function modelBanner(entries: readonly BannerEntry[], heading: string): string {
  if (entries.length === 0) return '';
  const rows = collapse(entries);
  const idWidth = Math.max(...rows.map((r) => r.modelId.length));
  const capWidth = Math.max(...rows.map((r) => r.capability.length));
  const lines = rows.map((row) => {
    const cells = [
      `  ${pad(row.modelId, idWidth)}`,
      pad(row.capability, capWidth),
      contextPart(row.limits),
      row.limits ? pricePart(row.limits) : 'price unknown',
    ];
    const source = sourcePart(row.limits);
    if (source !== '') cells.push(source);
    return cells.join('  ');
  });
  return `Models — ${heading}\n${lines.join('\n')}\n`;
}

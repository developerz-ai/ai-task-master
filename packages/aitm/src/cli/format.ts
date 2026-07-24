// Presentation helpers for command output: pure functions from data to display strings, no I/O.
// commands.ts stays arg-parsing + exit-code dispatch; every "turn this value into terminal text"
// concern (usage lines, PR links, config/profile listings, masking) lives here instead.

import type { ConfigFile, Profile } from '../config/schema.ts';
import type { PrGroup } from '../domain/pr-group.ts';
import type { RoleUsage, UsageTotals } from '../observability/usage-tracker.ts';
import { maskSecret } from './mask-secret.ts';

// Pre-run banner shown when auto-merge is active. aitm merges its own PRs via a `gh` subprocess,
// outside Claude Code's tool boundary — so a host repo's git-guard hook can't intercept it. Make
// the default behaviour explicit and point at the off switch. Returns null when auto-merge is off.
export function autoMergeNotice(autoMerge: boolean): string | null {
  if (!autoMerge) return null;
  return [
    '⚠ auto-merge is ON — every PR will be merged automatically when CI passes.',
    "  PR merges run via `gh`, outside Claude Code's tool boundary, so host git-guard hooks cannot intercept them.",
    '  Pass --no-automerge for this run, or `aitm config set autoMerge false` to disable it by default.',
    '',
  ].join('\n');
}

// Cache-hit % of input tokens served from cache (issue #114 amendment, slice 04b). 0 input tokens →
// `0%` rather than NaN/Infinity. Rounded to the nearest percent — this is a glance metric, not a
// billing figure (costUsd already carries the precise cache-aware math).
function cacheHitPct(usage: RoleUsage): string {
  if (usage.inputTokens === 0) return '0%';
  return `${Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)}%`;
}

// The `…/pull/` prefix shared by every PR on one repo, recovered from any group that did persist a
// URL. A run resumed across an aitm upgrade holds a mix: groups finished by the old binary carry no
// prUrl, groups finished by the new one do — and printing `#1  title — #1` for the former is a
// non-link that says nothing. One sibling's URL is enough to reconstruct all of them, with no extra
// `gh` call. Undefined when no group has a URL to learn from.
function pullUrlPrefix(groups: readonly PrGroup[]): string | undefined {
  for (const group of groups) {
    const url = group.prUrl;
    if (url === undefined) continue;
    const cut = url.lastIndexOf('/pull/');
    if (cut !== -1) return url.slice(0, cut + '/pull/'.length);
  }
  return undefined;
}

// The end-of-run PR block: one line per group that opened a PR, with the number, the group title,
// and the URL to click. Printed on every outcome — a merged run, a run parked at awaiting-pr, and a
// blocked one all leave PRs the operator wants to open. '' when the run opened none, so a plan-only
// or nothing-to-ship run prints no empty header. A group with no persisted prUrl borrows a sibling's
// repo prefix, and only falls back to the bare number when nothing in the run knows the repo URL.
export function prLinksBlock(groups: readonly PrGroup[]): string {
  const withPr = groups.filter((g) => g.pr !== null);
  if (withPr.length === 0) return '';
  const prefix = pullUrlPrefix(withPr);
  const lines = withPr.map((g) => {
    const target = g.prUrl ?? (prefix !== undefined ? `${prefix}${g.pr}` : `#${g.pr}`);
    return `  #${g.pr}  ${g.title} — ${target}`;
  });
  return `Pull requests:\n${lines.join('\n')}\n`;
}

// One end-of-run token/cost summary line (issue #114): overall tokens + per-role breakdown, with the
// estimated total USD or `cost unknown` when any model's pricing was unavailable. Adds cache-hit %
// (slice 04b) and, when the endpoint echoed one (`usage: { include: true }`, credentials.ts
// chatSettings), the provider-reported `cache_discount` savings — omitted, not `$0`, when no call
// ever reported one.
export function usageSummaryLine(totals: UsageTotals): string {
  const { overall } = totals;
  // A reference-priced total is what this work costs at OpenRouter list rates, not what the
  // configured endpoint charged — on a flat subscription those are different numbers, and printing
  // the estimate unlabelled would read as a bill.
  const estimateNote = totals.costEstimated ? ' est. at OpenRouter list rates' : '';
  const cost =
    overall.costUsd === null ? 'cost unknown' : `$${overall.costUsd.toFixed(4)}${estimateNote}`;
  const discount =
    overall.cacheDiscountUsd !== null
      ? `, $${overall.cacheDiscountUsd.toFixed(4)} cache discount`
      : '';
  const perRole = Object.entries(totals.perRole)
    .filter((entry): entry is [string, RoleUsage] => entry[1] !== undefined)
    .map(
      ([role, u]) =>
        `${role} ${u.inputTokens}in/${u.outputTokens}out (${cacheHitPct(u)} cache hit)`,
    )
    .join(', ');
  return `Usage: ${overall.calls} calls, ${overall.inputTokens} in / ${overall.outputTokens} out tokens (${overall.cachedInputTokens} cached, ${cacheHitPct(overall)} cache hit), ${cost}${discount}${perRole ? ` — ${perRole}` : ''}\n`;
}

// Mask a secret for display: keep the non-secret `sk-or-` prefix + last 4 chars so the user can
// confirm WHICH key is set without exposing it. Short values are fully hidden.
export function formatConfigValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

// One line per profile: an active marker, the name, its base URL, and a masked key hint.
export function formatProfileList(
  active: string | undefined,
  profiles: Record<string, Profile>,
): string {
  const names = Object.keys(profiles).sort();
  if (names.length === 0) {
    return 'No profiles configured. Create one with `aitm profile add <name> --preset zai`.\n';
  }
  const lines = names.map((name) => {
    const p = profiles[name] ?? {};
    const marker = name === active ? '*' : ' ';
    const base = p.baseURL ?? '(provider default)';
    const key = p.openrouterApiKey ? maskSecret(p.openrouterApiKey) : '(no key)';
    return `${marker} ${name}\t${base}\t${key}`;
  });
  return `${lines.join('\n')}\n`;
}

// Mask the API key inside a single profile for display.
export function redactProfile(profile: Profile): Profile {
  return profile.openrouterApiKey
    ? { ...profile, openrouterApiKey: maskSecret(profile.openrouterApiKey) }
    : profile;
}

// Redact a whole config file for `config list`: the top-level key and every profile's key.
export function redactConfigKeys(file: ConfigFile): ConfigFile {
  const out: ConfigFile = file.openrouterApiKey
    ? { ...file, openrouterApiKey: maskSecret(file.openrouterApiKey) }
    : { ...file };
  if (out.profiles) {
    const profiles: Record<string, Profile> = {};
    for (const [name, profile] of Object.entries(out.profiles)) {
      profiles[name] = redactProfile(profile);
    }
    out.profiles = profiles;
  }
  return out;
}

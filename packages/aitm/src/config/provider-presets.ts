// docs/commands/profile.md, docs/providers.md, docs/config.md
// Built-in provider presets for `aitm profile add --preset <name>`. Each preset seeds the
// provider triple (base URL + suggested per-tier models); the API key is always supplied
// separately (--api-key or `aitm profile set`), never hardcoded here. Every preset is an
// OpenAI-compatible endpoint — no Anthropic SDK path (see docs/auth.md §Anthropic).

import type { Profile } from './schema.ts';

export type PresetName = 'openrouter' | 'zai';

export const PROVIDER_PRESETS: Readonly<Record<PresetName, Profile>> = {
  // The provider default. Models left unset so the built-in capability defaults apply.
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
  },
  // z.ai GLM coding plan (OpenAI-compatible). GLM-4.6 for reasoning/coding, GLM-4.5-Air
  // for cheap routing/summarization. Verified end-to-end against this endpoint.
  zai: {
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    models: {
      generic: 'glm-4.6',
      smart: 'glm-4.6',
      coding: 'glm-4.6',
      fast: 'glm-4.5-air',
    },
  },
};

export const PRESET_NAMES: readonly PresetName[] = Object.keys(PROVIDER_PRESETS) as PresetName[];

// Own-property check (not `in`) so inherited names like `toString` don't pass the guard —
// a false positive would flow a non-preset into `profile add` and crash on the missing entry.
export function isPresetName(s: string): s is PresetName {
  return Object.hasOwn(PROVIDER_PRESETS, s);
}

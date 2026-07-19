// docs/commands/profile.md, docs/providers.md, docs/config.md
// Built-in provider presets for `aitm profile add --preset <name>`. Each preset seeds the
// provider triple (base URL + suggested per-tier models); the API key is always supplied
// separately (--api-key or `aitm profile set`), never hardcoded here. Every preset is an
// OpenAI-compatible endpoint — no Anthropic SDK path (see docs/auth.md §Anthropic).

import type { Profile } from './schema.ts';

export type PresetName = 'openrouter' | 'zai' | 'moonshot';

export const PROVIDER_PRESETS: Readonly<Record<PresetName, Profile>> = {
  // The provider default. Models left unset so the built-in capability defaults apply.
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
  },
  // z.ai GLM coding plan (OpenAI-compatible). GLM-5.2 for reasoning/coding, GLM-5-Turbo for
  // cheap routing/summarization. These are a current-as-of-release starting point — z.ai has
  // no stable "latest" alias, so override `models.*` (or `aitm profile set z.ai models.<tier>`)
  // when newer ids ship.
  zai: {
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    models: {
      generic: 'glm-5.2',
      smart: 'glm-5.2',
      coding: 'glm-5.2',
      fast: 'glm-5-turbo',
    },
  },
  // Moonshot AI Kimi coding plan (OpenAI-compatible). Kimi-k2 for reasoning/coding, automatic
  // prompt caching via prompt_cache_key. Override `models.*` for newer versions (e.g. kimi-k2.5).
  moonshot: {
    baseURL: 'https://api.moonshot.ai/v1',
    models: {
      generic: 'kimi-k2',
      smart: 'kimi-k2',
      coding: 'kimi-k2',
      fast: 'kimi-k2',
    },
  },
};

// Caching strategy per preset: 'automatic' (upstream provider automatic caching, prompt_cache_key)
// or 'cache_control' (explicit cache_control: ephemeral breakpoints for Anthropic models on OpenRouter).
export const PRESET_CACHING: Readonly<Record<PresetName, 'automatic' | 'cache_control'>> = {
  openrouter: 'automatic',
  zai: 'automatic',
  moonshot: 'automatic',
};

export const PRESET_NAMES: readonly PresetName[] = Object.keys(PROVIDER_PRESETS) as PresetName[];

// Own-property check (not `in`) so inherited names like `toString` don't pass the guard —
// a false positive would flow a non-preset into `profile add` and crash on the missing entry.
export function isPresetName(s: string): s is PresetName {
  return Object.hasOwn(PROVIDER_PRESETS, s);
}

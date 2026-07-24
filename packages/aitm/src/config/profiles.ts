// docs/commands/profile.md, docs/providers.md, docs/config.md
// Named provider profiles in ~/.aitm.json — switch the provider triple (API key + base
// URL + per-tier models) in one command, version-manager style. This module owns profile
// mutations on the GLOBAL config file only; resolution precedence lives in ConfigLoader.
// Atomic write (temp file + rename) + ConfigFileSchema validation before persisting.

import { join } from 'node:path';
import { ZodError } from 'zod';
import { atomicWrite } from '../fs/atomic-write.ts';
import { asObject, getDotted, parseValue, setDotted, splitDottedKey } from './dotted-path.ts';
import { formatZodError, readJsonObjectFile } from './json-file.ts';
import { PROVIDER_PRESETS, type PresetName } from './provider-presets.ts';
import {
  type ConfigFile,
  ConfigFileSchema,
  FORBIDDEN_KEY_SEGMENTS,
  type Profile,
} from './schema.ts';

const GLOBAL_FILE = '.aitm.json';

export type AddProfileInput = {
  preset?: PresetName;
  baseURL?: string;
  apiKey?: string;
};

export type ProfileListing = {
  activeProfile: string | undefined;
  profiles: Record<string, Profile>;
};

export class ProfileManager {
  constructor(private readonly homeDir: string) {}

  async list(): Promise<ProfileListing> {
    const validated = await this.readValidated();
    return {
      activeProfile: validated.activeProfile,
      profiles: validated.profiles ?? {},
    };
  }

  // Switch the active profile. Refuses to point `activeProfile` at a profile that doesn't
  // exist — a dangling pointer would silently fall back to env at run time.
  async use(name: string): Promise<void> {
    assertProfileName(name);
    const file = await this.readRaw();
    const profiles = asObject(file.profiles);
    if (!Object.hasOwn(profiles, name)) {
      throw new Error(unknownProfileMessage(name, Object.keys(profiles)));
    }
    file.activeProfile = name;
    await this.persist(file);
  }

  // Create a new profile from an optional preset plus explicit overrides. Auto-activates
  // the first profile created so `aitm profile add … && aitm start` works without a
  // separate `use`. Refuses to clobber an existing profile (use `set` to modify).
  async add(name: string, input: AddProfileInput = {}): Promise<Profile> {
    assertProfileName(name);
    const file = await this.readRaw();
    const profiles = ensureObject(file, 'profiles');
    if (Object.hasOwn(profiles, name)) {
      throw new Error(
        `Profile "${name}" already exists. Use \`aitm profile set ${name} <key> <value>\` to modify it.`,
      );
    }
    const profile: Record<string, unknown> = input.preset
      ? jsonClone(PROVIDER_PRESETS[input.preset])
      : {};
    if (input.baseURL !== undefined) profile.baseURL = input.baseURL;
    if (input.apiKey !== undefined) profile.openrouterApiKey = input.apiKey;
    profiles[name] = profile;
    if (file.activeProfile === undefined) file.activeProfile = name;
    const validated = await this.persist(file);
    return validated.profiles?.[name] ?? {};
  }

  // Set a field on an existing profile. `key` is `openrouterApiKey`, `baseURL`, or
  // `models.<tier>`. Value is JSON-parsed (bare strings stay literal), like `config set`.
  async set(name: string, key: string, value: unknown): Promise<Profile> {
    assertProfileName(name);
    const file = await this.readRaw();
    const profiles = asObject(file.profiles);
    if (!Object.hasOwn(profiles, name)) {
      throw new Error(unknownProfileMessage(name, Object.keys(profiles)));
    }
    const profile = asObject(profiles[name]);
    setDotted(profile, splitKey(key), parseValue(value));
    profiles[name] = profile;
    (file as Record<string, unknown>).profiles = profiles;
    const validated = await this.persist(file);
    return validated.profiles?.[name] ?? {};
  }

  async get(name: string, key: string): Promise<unknown> {
    assertProfileName(name);
    const { profiles } = await this.list();
    const profile = ownProfile(profiles, name);
    if (profile === undefined) {
      throw new Error(unknownProfileMessage(name, Object.keys(profiles)));
    }
    return getDotted(profile as Record<string, unknown>, splitKey(key));
  }

  // Delete a profile. If it was active, clear `activeProfile` so the next run falls back
  // cleanly to top-level config / env rather than dangling at a removed name.
  async remove(name: string): Promise<void> {
    assertProfileName(name);
    const file = await this.readRaw();
    const profiles = asObject(file.profiles);
    if (!Object.hasOwn(profiles, name)) {
      throw new Error(unknownProfileMessage(name, Object.keys(profiles)));
    }
    delete profiles[name];
    if (file.activeProfile === name) delete file.activeProfile;
    await this.persist(file);
  }

  // Resolve a single profile for display. `name` defaults to the active profile.
  async show(name?: string): Promise<{ name: string; profile: Profile }> {
    const { activeProfile, profiles } = await this.list();
    const target = name ?? activeProfile;
    if (target === undefined) {
      throw new Error(
        'No profile specified and no active profile set. Pass a name or run `aitm profile use <name>`.',
      );
    }
    assertProfileName(target);
    const profile = ownProfile(profiles, target);
    if (profile === undefined) {
      throw new Error(unknownProfileMessage(target, Object.keys(profiles)));
    }
    return { name: target, profile };
  }

  private filePath(): string {
    return join(this.homeDir, GLOBAL_FILE);
  }

  private async readRaw(): Promise<Record<string, unknown>> {
    return readJsonObjectFile(this.filePath());
  }

  private async readValidated(): Promise<ConfigFile> {
    return this.validate(await this.readRaw());
  }

  private validate(file: Record<string, unknown>): ConfigFile {
    try {
      return ConfigFileSchema.parse(file);
    } catch (err) {
      if (err instanceof ZodError) throw new Error(`${this.filePath()}: ${formatZodError(err)}`);
      throw err;
    }
  }

  private async persist(file: Record<string, unknown>): Promise<ConfigFile> {
    const validated = this.validate(file);
    await atomicWrite(this.filePath(), `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  }
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = asObject(parent[key]);
  parent[key] = next;
  return next;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Only these may be set/get on a profile (mirrors the documented surface). `models`,
// `providerRouting`, and `fallbackModels` are nesting roots, one level deep (`<root>.<field>`).
const ALLOWED_PROFILE_ROOT_KEYS: ReadonlySet<string> = new Set([
  'openrouterApiKey',
  'baseURL',
  'models',
  'providerRouting',
  'fallbackModels',
  'reasoningEffort',
]);
// Roots that take exactly one nested segment (`models.<tier>`, `providerRouting.<field>`,
// `fallbackModels.<tier>`, `reasoningEffort.<tier>`); every other allowed key is a bare scalar
// (issues #124, #125).
const ONE_LEVEL_NESTING_ROOTS: ReadonlySet<string> = new Set([
  'models',
  'providerRouting',
  'fallbackModels',
  'reasoningEffort',
]);
// Profile names index the `profiles` object, so the same reserved keys are dangerous there:
// `profiles.__proto__` resolves to Object.prototype and setDotted() would write onto it,
// polluting every object in the process. Names are validated before any lookup, and membership
// is own-property only (like isPresetName) so inherited keys — `constructor`, `toString` — can
// neither masquerade as an existing profile nor be handed back as one.
function assertProfileName(name: string): void {
  if (name.trim() === '') throw new Error('Profile name must be non-empty.');
  if (FORBIDDEN_KEY_SEGMENTS.has(name)) {
    throw new Error(`Invalid profile name: "${name}" — reserved word. Choose a different name.`);
  }
}

function ownProfile<T>(profiles: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}

const KEY_SURFACE_HINT =
  'Allowed keys: openrouterApiKey, baseURL, models.<tier>, providerRouting.<field>, fallbackModels.<tier>, reasoningEffort.<tier>.';

// Parse and validate a profile key path. Enforces the documented key surface and rejects
// dangerous segments, so neither `set` nor `get` can mutate prototypes or write off-schema.
function splitKey(key: string): [string, ...string[]] {
  const [first, ...rest] = splitDottedKey(key, 'profile key', KEY_SURFACE_HINT);
  if (!ALLOWED_PROFILE_ROOT_KEYS.has(first)) {
    throw new Error(`Invalid profile key: "${key}". ${KEY_SURFACE_HINT}`);
  }
  if (ONE_LEVEL_NESTING_ROOTS.has(first) ? rest.length !== 1 : rest.length !== 0) {
    throw new Error(`Invalid profile key: "${key}". ${KEY_SURFACE_HINT}`);
  }
  return [first, ...rest];
}

function unknownProfileMessage(name: string, available: readonly string[]): string {
  const list = available.length > 0 ? available.slice().sort().join(', ') : '(none)';
  return `Unknown profile "${name}". Available: ${list}. Create it with \`aitm profile add ${name}\`.`;
}

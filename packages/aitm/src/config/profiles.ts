// docs/commands/profile.md, docs/providers.md, docs/config.md
// Named provider profiles in ~/.aitm.json — switch the provider triple (API key + base
// URL + per-tier models) in one command, version-manager style. This module owns profile
// mutations on the GLOBAL config file only; resolution precedence lives in ConfigLoader.
// Atomic write (temp file + rename) + ConfigFileSchema validation before persisting.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { atomicWrite } from '../fs/atomic-write.ts';
import { PROVIDER_PRESETS, type PresetName } from './provider-presets.ts';
import { type ConfigFile, ConfigFileSchema, type Profile } from './schema.ts';

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
    const file = await this.readRaw();
    const profiles = asObject(file.profiles);
    if (!(name in profiles)) {
      throw new Error(unknownProfileMessage(name, Object.keys(profiles)));
    }
    file.activeProfile = name;
    await this.persist(file);
  }

  // Create a new profile from an optional preset plus explicit overrides. Auto-activates
  // the first profile created so `aitm profile add … && aitm start` works without a
  // separate `use`. Refuses to clobber an existing profile (use `set` to modify).
  async add(name: string, input: AddProfileInput = {}): Promise<Profile> {
    if (name.trim() === '') throw new Error('Profile name must be non-empty.');
    const file = await this.readRaw();
    const profiles = ensureObject(file, 'profiles');
    if (name in profiles) {
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
    const file = await this.readRaw();
    const profiles = asObject(file.profiles);
    if (!(name in profiles)) {
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
    const { profiles } = await this.list();
    const profile = profiles[name];
    if (profile === undefined) {
      throw new Error(unknownProfileMessage(name, Object.keys(profiles)));
    }
    return getDotted(profile as Record<string, unknown>, splitKey(key));
  }

  // Delete a profile. If it was active, clear `activeProfile` so the next run falls back
  // cleanly to top-level config / env rather than dangling at a removed name.
  async remove(name: string): Promise<void> {
    const file = await this.readRaw();
    const profiles = asObject(file.profiles);
    if (!(name in profiles)) {
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
    const profile = profiles[target];
    if (profile === undefined) {
      throw new Error(unknownProfileMessage(target, Object.keys(profiles)));
    }
    return { name: target, profile };
  }

  private filePath(): string {
    return join(this.homeDir, GLOBAL_FILE);
  }

  private async readRaw(): Promise<Record<string, unknown>> {
    const path = this.filePath();
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return {};
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${path}: invalid JSON — ${msg}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${path}: expected a JSON object at the top level`);
    }
    return parsed as Record<string, unknown>;
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

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = asObject(parent[key]);
  parent[key] = next;
  return next;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Only these may be set/get on a profile (mirrors the documented surface). `models` is the
// only nesting root and only one level deep (models.<tier>).
const ALLOWED_PROFILE_ROOT_KEYS: ReadonlySet<string> = new Set([
  'openrouterApiKey',
  'baseURL',
  'models',
]);
// Reserved object keys that would let a dotted path reach Object.prototype before the schema
// runs — rejected outright to close a prototype-pollution vector in setDotted().
const FORBIDDEN_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

const KEY_SURFACE_HINT = 'Allowed keys: openrouterApiKey, baseURL, models.<tier>.';

// Parse and validate a profile key path. Enforces the documented key surface and rejects
// dangerous segments, so neither `set` nor `get` can mutate prototypes or write off-schema.
function splitKey(key: string): [string, ...string[]] {
  const parts = key.split('.');
  if (parts.length === 0 || parts.some((p) => p === '')) {
    throw new Error(`Invalid profile key: "${key}". ${KEY_SURFACE_HINT}`);
  }
  if (parts.some((p) => FORBIDDEN_KEY_SEGMENTS.has(p))) {
    throw new Error(`Invalid profile key: "${key}" — reserved segment. ${KEY_SURFACE_HINT}`);
  }
  const [first, ...rest] = parts;
  if (first === undefined || !ALLOWED_PROFILE_ROOT_KEYS.has(first)) {
    throw new Error(`Invalid profile key: "${key}". ${KEY_SURFACE_HINT}`);
  }
  if (first === 'models' ? rest.length !== 1 : rest.length !== 0) {
    throw new Error(`Invalid profile key: "${key}". ${KEY_SURFACE_HINT}`);
  }
  return [first, ...rest];
}

function setDotted(obj: Record<string, unknown>, parts: readonly string[], value: unknown): void {
  const [first, ...rest] = parts;
  if (first === undefined) return;
  if (rest.length === 0) {
    obj[first] = value;
    return;
  }
  const sub = asObject(obj[first]);
  obj[first] = sub;
  setDotted(sub, rest, value);
}

function getDotted(obj: Record<string, unknown>, parts: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function parseValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function unknownProfileMessage(name: string, available: readonly string[]): string {
  const list = available.length > 0 ? available.slice().sort().join(', ') : '(none)';
  return `Unknown profile "${name}". Available: ${list}. Create it with \`aitm profile add ${name}\`.`;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function formatZodError(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

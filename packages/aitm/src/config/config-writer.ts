// docs/commands/config.md, docs/config.md
// Mutates ~/.aitm.json (or, with --project, ./.ai-task-master/config.json) for `aitm config set/unset`.
// Atomic write: temp file + rename. Refuses to write unknown top-level keys.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { atomicWrite } from '../fs/atomic-write.ts';
import { type ConfigFile, ConfigFileSchema } from './schema.ts';

export type ConfigScope = 'global' | 'project';

const GLOBAL_FILE = '.aitm.json';
const PROJECT_DIR = '.ai-task-master';
const PROJECT_FILE = 'config.json';

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'openrouterApiKey',
  'models',
  'maxPrs',
  'maxSessions',
  'autoMerge',
  'mergeMethod',
  'stylePath',
  'logLevel',
  'concurrency',
  'mcpServers',
]);

export class ConfigWriter {
  constructor(
    private readonly cwd: string,
    private readonly homeDir: string,
  ) {}

  async set(scope: ConfigScope, key: string, value: unknown): Promise<ConfigFile> {
    const parts = splitKey(key);
    const top = parts[0];
    if (!KNOWN_KEYS.has(top)) {
      throw new Error(unknownKeyMessage(top));
    }
    const file = await this.readRaw(scope);
    setDottedKey(file, parts, parseValue(value));
    return this.validateAndPersist(scope, file);
  }

  async unset(scope: ConfigScope, key: string): Promise<ConfigFile> {
    const parts = splitKey(key);
    const file = await this.readRaw(scope);
    unsetDottedKey(file, parts);
    return this.validateAndPersist(scope, file);
  }

  async get(scope: ConfigScope, key: string): Promise<unknown> {
    const parts = splitKey(key);
    const file = await this.readRaw(scope);
    return getDottedKey(file, parts);
  }

  async list(scope: ConfigScope): Promise<ConfigFile> {
    const file = await this.readRaw(scope);
    return validateSchema(file, this.filePath(scope));
  }

  private filePath(scope: ConfigScope): string {
    return scope === 'global'
      ? join(this.homeDir, GLOBAL_FILE)
      : join(this.cwd, PROJECT_DIR, PROJECT_FILE);
  }

  private async readRaw(scope: ConfigScope): Promise<Record<string, unknown>> {
    const path = this.filePath(scope);
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

  private async validateAndPersist(
    scope: ConfigScope,
    file: Record<string, unknown>,
  ): Promise<ConfigFile> {
    const path = this.filePath(scope);
    const validated = validateSchema(file, path);
    if (scope === 'project') {
      await mkdir(dirname(path), { recursive: true });
    }
    await atomicWrite(path, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  }
}

function validateSchema(file: unknown, path: string): ConfigFile {
  try {
    return ConfigFileSchema.parse(file);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`${path}: ${formatZodError(err)}`);
    }
    throw err;
  }
}

function parseValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    // Bare strings ("squash", "sk-or-...") aren't valid JSON; treat them as literal strings.
    return v;
  }
}

function splitKey(key: string): [string, ...string[]] {
  const parts = key.split('.');
  if (parts.length === 0 || parts.some((p) => p === '')) {
    throw new Error(`Invalid config key: "${key}"`);
  }
  const [first, ...rest] = parts;
  if (first === undefined) {
    throw new Error(`Invalid config key: "${key}"`);
  }
  return [first, ...rest];
}

function setDottedKey(
  obj: Record<string, unknown>,
  parts: readonly string[],
  value: unknown,
): void {
  const [first, ...rest] = parts;
  if (first === undefined) return;
  if (rest.length === 0) {
    obj[first] = value;
    return;
  }
  const existing = obj[first];
  const sub: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  obj[first] = sub;
  setDottedKey(sub, rest, value);
}

function unsetDottedKey(obj: Record<string, unknown>, parts: readonly string[]): void {
  const [first, ...rest] = parts;
  if (first === undefined) return;
  if (rest.length === 0) {
    delete obj[first];
    return;
  }
  const next = obj[first];
  if (next === null || typeof next !== 'object' || Array.isArray(next)) return;
  unsetDottedKey(next as Record<string, unknown>, rest);
}

function getDottedKey(obj: Record<string, unknown>, parts: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function unknownKeyMessage(top: string): string {
  const allowed = [...KNOWN_KEYS].sort().join(', ');
  return `Unknown config key "${top}". Allowed top-level keys: ${allowed}`;
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

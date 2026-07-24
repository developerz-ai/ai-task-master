// Dotted-path helpers shared by ConfigWriter and ProfileManager: split/validate a dotted key
// ("models.coding"), then read/write/delete the value it points at inside a plain nested object,
// plus parse a CLI-supplied value. Both surfaces gate every key through splitDottedKey first, so a
// reserved segment (__proto__, constructor) can never reach setDotted and pollute a prototype.

import { FORBIDDEN_KEY_SEGMENTS } from './schema.ts';

// A plain (non-array, non-null) object, or a fresh one — the nesting shape setDotted walks into.
export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// A raw CLI string is JSON when it parses (numbers, booleans, arrays, objects); otherwise it is a
// bare string ("squash", "sk-or-..."). Already-typed values pass through untouched.
export function parseValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// Split a dotted key into non-empty segments, rejecting reserved segments that would let the path
// reach Object.prototype in setDotted. `label` names the surface ("config key"/"profile key"); an
// optional `hint` is appended to every error so each surface keeps its own guidance verbatim.
export function splitDottedKey(key: string, label: string, hint?: string): [string, ...string[]] {
  const suffix = hint ? `. ${hint}` : '';
  const parts = key.split('.');
  if (parts.length === 0 || parts.some((p) => p === '')) {
    throw new Error(`Invalid ${label}: "${key}"${suffix}`);
  }
  if (parts.some((p) => FORBIDDEN_KEY_SEGMENTS.has(p))) {
    throw new Error(`Invalid ${label}: "${key}" — reserved segment${suffix}`);
  }
  const [first, ...rest] = parts;
  if (first === undefined) {
    throw new Error(`Invalid ${label}: "${key}"${suffix}`);
  }
  return [first, ...rest];
}

export function setDotted(
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
  const sub = asObject(obj[first]);
  obj[first] = sub;
  setDotted(sub, rest, value);
}

export function getDotted(obj: Record<string, unknown>, parts: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function unsetDotted(obj: Record<string, unknown>, parts: readonly string[]): void {
  const [first, ...rest] = parts;
  if (first === undefined) return;
  if (rest.length === 0) {
    delete obj[first];
    return;
  }
  const next = obj[first];
  if (next === null || typeof next !== 'object' || Array.isArray(next)) return;
  unsetDotted(next as Record<string, unknown>, rest);
}

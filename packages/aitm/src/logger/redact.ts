// Redaction policy over an arbitrary object graph: a value whose KEY NAME looks secret-bearing is
// dropped wholesale, every other string is run through the free-text scrubber. Shared by the logger
// (structured log fields) and the GlitchTip reporter (`beforeSend`), which need the same policy but
// opposite ownership: the logger must not mutate caller-owned objects, the reporter must hand back
// the very event object Sentry gave it.

import { scrubSecrets } from './secret-scrubber.ts';

const REDACT_KEY = /key|token|secret|authorization/i;
const REDACTED = '[REDACTED]';

// `seen` holds only the CURRENT ancestor chain (added before recursing into a value's children,
// removed after) so exactly true cycles read "[CYCLE]". A grow-only set would also flag an object
// that merely appears twice as siblings (SDK messages share references freely, e.g. one
// providerOptions object across tool-result parts) — corrupting valid data into a string that then
// fails modelMessageSchema on transcript reconstruction (issue #251).
export function redactCopy(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CYCLE]';
    seen.add(value);
    const out = value.map((v) => redactCopy(v, seen));
    seen.delete(value);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[CYCLE]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEY.test(k) ? REDACTED : redactCopy(v, seen);
    }
    seen.delete(value);
    return out;
  }
  return typeof value === 'string' ? scrubSecrets(value) : value;
}

// In-place twin of `redactCopy`. Nothing is replaced by a "[CYCLE]" marker here, so a grow-only
// visited set is the right shape: an already-walked object is already scrubbed, back-edge and
// shared sibling alike.
export function redactInPlace(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (seen.has(items)) return;
    seen.add(items);
    for (const [index, item] of items.entries()) {
      if (typeof item === 'string') items[index] = scrubSecrets(item);
      else redactInPlace(item, seen);
    }
    return;
  }
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEY.test(k)) value[k] = REDACTED;
    else if (typeof v === 'string') value[k] = scrubSecrets(v);
    else redactInPlace(v, seen);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

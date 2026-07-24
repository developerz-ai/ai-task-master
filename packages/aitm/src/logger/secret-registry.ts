// Literal-value redaction: the exact credential strings this process was configured with. The
// pattern scrubber (`./secret-scrubber.ts`) recognises known vendor token SHAPES — but `aitm` talks
// to any OpenAI-compatible endpoint, and a key minted by one of those has no shape worth matching:
// it can be a UUID, a bare hex blob, anything. The only reliable signal for such a key is the key
// itself, so `ConfigLoader.resolve` registers every provider key it reads at startup and the shared
// scrubber consults this registry before running its patterns.
//
// Process-wide by design: the registry has to be reachable from every output channel (logger,
// progress stream, error reporter) without threading a handle through call sites that have no other
// reason to know about credentials.

const REDACTED = '[REDACTED]';

// Values shorter than this are refused. A short "key" — a placeholder, a test stub, a truncated
// paste — would match ordinary prose and black out unrelated output, which hides the run's real
// behaviour without protecting anything a real credential wasn't already protecting.
const MIN_SECRET_LENGTH = 8;

// Longest-first, so a secret that contains a shorter registered secret is replaced whole instead of
// leaving the surrounding characters of the longer key in the clear.
let secrets: string[] = [];

// Add literal secret values to the registry. Non-strings, blanks and too-short values are skipped,
// so callers can pass optional config fields straight through. Registration is append-only for the
// life of the process: a key that was live earlier in a run stays redacted even if a later resolve
// swaps it out, since log lines and queued error events from before the swap still carry it.
export function registerSecretValues(values: Iterable<string | null | undefined>): void {
  let added = false;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_LENGTH || secrets.includes(trimmed)) continue;
    secrets.push(trimmed);
    added = true;
  }
  if (added) secrets.sort((a, b) => b.length - a.length);
}

// Replace every occurrence of every registered secret. Safe to call on any string — with nothing
// registered, or nothing matching, the input passes through untouched.
export function redactRegisteredSecrets(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

// Drop every registered value. For tests only — production code never un-registers a live key.
export function clearRegisteredSecrets(): void {
  secrets = [];
}

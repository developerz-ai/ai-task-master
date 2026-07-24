// Secret-shaped substring detection, shared by the logger (`msg`/field values), the progress
// stream and the GlitchTip error reporter (`beforeSend`). Complements key-name redaction: catches
// secrets embedded in free text — log messages, error messages/stacks, URLs — where there is no key
// name to match against.
//
// Shape matching only covers credentials issued in a recognisable format, so it is layered over
// literal-value redaction (`./secret-registry.ts`), which covers the keys this process was actually
// configured with whatever they look like.

import { redactRegisteredSecrets } from './secret-registry.ts';

const REDACTED = '[REDACTED]';

// Each pattern either replaces the whole match, or — when it has a capture group — keeps the
// captured prefix (e.g. `Bearer `, `?token=`) and redacts only the secret portion.
const SECRET_PATTERNS: RegExp[] = [
  // Authorization-style headers embedded in text: "Bearer <token>", "Basic <token>".
  /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // Vendor token prefixes: OpenAI/OpenRouter sk-/pk-/rk-, GitHub gh[pousr]_/github_pat_,
  // Slack xox[abps]-/xapp-, AWS AKIA/ASIA, Google AIza, GitLab glpat-, Hugging Face hf_,
  // npm npm_, and Stripe _live_/_test_ variants.
  /\b((?:(?:sk|pk|rk)(?:-|_(?:live|test)_)|gh[pousr]_|github_pat_|xox[abps]-|xapp-|AKIA|ASIA|AIza|glpat-|hf_|npm_))[A-Za-z0-9_-]{12,}\b/g,
  // JWTs: header.payload.signature, each segment base64url.
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Token-bearing query params: ?token=..., &api_key=..., &access_token=..., &secret=...
  /([?&](?:token|api[_-]?key|access[_-]?token|secret|password)=)[^&\s'"]+/gi,
  // URL basic-auth credentials: scheme://user:pass@host
  /(:\/\/)[^/\s:@]+:[^/\s:@]+@/g,
];

// Scrub secret-shaped substrings out of free-text content. Safe to call on any string —
// text with no matches passes through unchanged. Registered literal keys go first: a configured key
// is then redacted whole, rather than a pattern clipping part of it and leaving a remnant the
// literal pass can no longer recognise.
export function scrubSecrets(text: string): string {
  let out = redactRegisteredSecrets(text);
  for (const pattern of SECRET_PATTERNS) {
    // Patterns with no capture group still pass a positional `offset` number as the second
    // callback arg — only a string second arg is an actual captured prefix to preserve.
    out = out.replace(pattern, (match: string, group1: unknown) =>
      typeof group1 === 'string' ? `${group1}${REDACTED}` : REDACTED,
    );
  }
  return out;
}

// Tolerated (non-blocking) CI check failures.
//
// Some status checks report a failure for reasons that have nothing to do with the code under
// review and that no commit can fix. Treating those as CI failures sends the loop into a pointless
// fix session and then spins on the same red check forever.
//
// The tolerated set is a whitelist: each rule names one check *and* the exact message that marks
// its failure as a quota/availability response rather than a verdict on the code. Anything else —
// including any other failure from the same check — still fails CI.
//
// Adding an exception: append a rule to TOLERATED_FAILURES, or, without waiting for a release,
// set AITM_TOLERATED_CHECK_FAILURES="some-bot=quota exceeded;other-bot=busy".
// Both sides are matched on trimmed, lower-cased text.

export type ToleratedFailure = {
  // Status-check name as reported by `gh pr checks` (case-insensitive).
  check: string;
  // The exact failure description to tolerate (case-insensitive). A failure with any other
  // description is a real failure.
  description: string;
  // Why it is safe to ignore — surfaced in the log line when a failure is discounted.
  reason: string;
};

// The shape both predicates take: a check's reported name and its optional free-text description.
export type ToleratedCheck = { name: string; description?: string | undefined };

// Env var holding extra rules as `check=description` pairs separated by `;` or newlines.
export const TOLERATED_FAILURES_ENV = 'AITM_TOLERATED_CHECK_FAILURES';

// The built-in exceptions. Extend this list to tolerate another check.
export const TOLERATED_FAILURES: readonly ToleratedFailure[] = [
  {
    check: 'CodeRabbit',
    description: 'Review rate limited',
    reason: 'CodeRabbit review quota, not a verdict on the code',
  },
];

// Malformed entries (no `=`, empty side) are skipped rather than thrown: a typo in an env var must
// not break CI evaluation.
function envRules(): ToleratedFailure[] {
  const raw = process.env[TOLERATED_FAILURES_ENV] ?? '';
  const rules: ToleratedFailure[] = [];
  for (const entry of raw.replace(/\n/g, ';').split(';')) {
    const index = entry.indexOf('=');
    if (index < 0) continue;
    const check = entry.slice(0, index).trim();
    const description = entry.slice(index + 1).trim();
    if (!check || !description) continue;
    rules.push({ check, description, reason: `declared in $${TOLERATED_FAILURES_ENV}` });
  }
  return rules;
}

// The rule's reason when a failing check may be ignored, else null.
export function toleratedReason(check: ToleratedCheck): string | null {
  const name = check.name.trim().toLowerCase();
  const description = (check.description ?? '').trim().toLowerCase();
  if (!name || !description) return null;
  for (const rule of [...TOLERATED_FAILURES, ...envRules()]) {
    if (rule.check.toLowerCase() === name && rule.description.toLowerCase() === description) {
      return rule.reason;
    }
  }
  return null;
}

export function isToleratedFailure(check: ToleratedCheck): boolean {
  return toleratedReason(check) !== null;
}

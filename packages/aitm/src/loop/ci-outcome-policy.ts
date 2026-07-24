// The CI recovery policy shared by aitm's two CI-driving loops: the stage machine (start flow —
// driveStages + stage-handlers, expressed as GroupStage transitions) and the prPerTask autoMergeFlow
// (inline control flow). Both must honor --admin's CI-timeout override and cap the fix loop at
// maxCiFixAttempts identically. Before this module they diverged — prPerTask ignored both: it ran a
// single fix pass with no cap, and a poll timeout blocked the group even under --admin.
//
// Pure decisions only — no I/O, no GroupStage, no persistence. Each caller translates a verdict into
// its own vocabulary (a next stage, or the next inline step) and owns the durability of the attempt
// count: the stage machine mirrors it onto PrGroup.ciFixAttempts (one PR per group, resume-safe);
// prPerTask keeps a fresh budget per task PR (each merges before the next, so nothing to carry).

import type { CiState } from '../github/github-client.ts';

// How a settled CI poll routes. `state` is what GitHubClient.waitForChecks returned, or null when it
// threw CiFailed (checks never settled within the poll window) — the caller catches CiFailed and
// passes null. A non-success settled state routes to the fix loop, matching the stage machine's
// original `state !== 'success' → ci-failed`; 'pending' only ever comes from an aborted poll, which
// every caller guards against before routing, so it never legitimately reaches here.
export type CiRoute =
  | { kind: 'proceed' } // CI green — advance to reviews / merge
  | { kind: 'fix' } // CI failing — run the shared fix session
  | { kind: 'advance' } // timed out, --admin on — skip past CI to reviews
  | { kind: 'block'; reason: string }; // timed out, --admin off — needs a human

export function routeCiPoll(state: CiState | null, pr: number, adminMerge: boolean): CiRoute {
  if (state === null) {
    return adminMerge
      ? { kind: 'advance' }
      : {
          kind: 'block',
          reason: `CI for PR #${pr} never completed within the poll window — needs human attention`,
        };
  }
  return state === 'success' ? { kind: 'proceed' } : { kind: 'fix' };
}

// The fix-attempt budget decision. `spent` is the count BEFORE this attempt; the returned `spent` is
// the count AFTER (persist it where the caller tracks the budget). `exhausted` once charging would
// exceed the cap: block WITHOUT running the fix (no LLM call, no push) so an unfixable red PR ends for
// a human instead of cycling forever. The returned count advances even on exhaustion — it names the
// blocking entry, so the stage machine's persisted counter lands on cap + 1, not the cap.
export type CiFixCharge =
  | { kind: 'dispatch'; spent: number }
  | { kind: 'exhausted'; spent: number; reason: string };

export function chargeCiFixAttempt(spent: number, max: number, pr: number): CiFixCharge {
  const next = spent + 1;
  if (next > max) {
    return {
      kind: 'exhausted',
      spent: next,
      reason: `CI fix attempts exhausted after ${max} passes for PR #${pr} — needs human attention`,
    };
  }
  return { kind: 'dispatch', spent: next };
}

// Timing constants for the CI-fix and merge-pr loops.
//
// Prompt-cache pacing economics (issue #109, NOT yet load-bearing): once a subagent transcript is
// held across one of these waits, the delay must respect the Anthropic prompt cache's 5-minute TTL.
// A wait that holds a cached prefix should either stay comfortably inside the TTL (≤ 270_000 ms — the
// next request still hits the cache) or accept and amortize a full cache miss (≥ 1_200_000 ms). A
// delay just past the TTL (≈ 300_000 ms) is the worst case: the prefix is re-written at full cost
// with almost none of the wait amortized — never choose it. This does not bind today: every sleep
// below runs BETWEEN fresh subagent contexts, so there is no held prefix to protect and no value
// changes here. It becomes load-bearing when transcripts persist across waits.

export const DEFAULT_MAX_ITERATIONS = 30; // max loop iterations before giving up
// Cap on CI-fix passes per group per driveStages run, bounding the waiting-ci ⇄ ci-failed recovery
// loop on an unfixable red PR (flaky infra, missing secret, a failure unrelated to the diff) so an
// unattended run blocks for a human instead of burning coding-tier tokens forever. See issue #128.
export const DEFAULT_MAX_CI_FIX_ATTEMPTS = 3;
// ms: grace period after CI passes before checking reviews. Review bots (CodeRabbit) post their
// comments a little *after* CI completes rather than as a blocking status check, so without this
// wait we'd race ahead and merge before the review lands.
export const REVIEW_COMMENTS_GRACE = 120_000;

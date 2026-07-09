// Timing constants for the CI-fix and merge-pr loops.

export const CI_POLL_INTERVAL = 10_000; // ms: wait between checks during CI poll
export const CI_START_WAIT = 60_000; // ms: wait before polling CI after push
export const CI_POLL_TIMEOUT = 600_000; // ms: total timeout for CI wait (10 min)
export const MERGE_STATE_WAIT = 60_000; // ms: wait before checking merge state after push
export const DEFAULT_MAX_ITERATIONS = 30; // max loop iterations before giving up
// Cap on CI-fix passes per group per driveStages run, bounding the waiting-ci ⇄ ci-failed recovery
// loop on an unfixable red PR (flaky infra, missing secret, a failure unrelated to the diff) so an
// unattended run blocks for a human instead of burning coding-tier tokens forever. See issue #128.
export const DEFAULT_MAX_CI_FIX_ATTEMPTS = 3;
// ms: grace period after CI passes before checking reviews. Review bots (CodeRabbit) post their
// comments a little *after* CI completes rather than as a blocking status check, so without this
// wait we'd race ahead and merge before the review lands.
export const REVIEW_COMMENTS_GRACE = 120_000;

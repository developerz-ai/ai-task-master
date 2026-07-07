// Timing constants for the CI-fix and merge-pr loops.

export const CI_POLL_INTERVAL = 10_000; // ms: wait between checks during CI poll
export const CI_START_WAIT = 60_000; // ms: wait before polling CI after push
export const CI_POLL_TIMEOUT = 600_000; // ms: total timeout for CI wait (10 min)
export const MERGE_STATE_WAIT = 60_000; // ms: wait before checking merge state after push
export const DEFAULT_MAX_ITERATIONS = 30; // max loop iterations before giving up
// ms: grace period after CI passes before checking reviews. Review bots (CodeRabbit) post their
// comments a little *after* CI completes rather than as a blocking status check, so without this
// wait we'd race ahead and merge before the review lands.
export const REVIEW_COMMENTS_GRACE = 120_000;

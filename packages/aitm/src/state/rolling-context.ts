// Deterministic per-group rolling context (issue #123). After a PR opens, one block is appended to
// context.md summarizing what that group shipped, so the next group's Worker plans against it instead
// of re-surveying from zero. Purely deterministic — every input (change summaries, progress entries)
// was already produced at edit time, so there is no LLM call, no latency, and no new failure surface
// on the PR-open path. FIFO-capped so a long run's context never grows unbounded.
// docs/state.md §context.md

import type { PullRequest } from '../github/schema.ts';
import type { WorkerDelivery } from '../subagents/worker.ts';
import type { PrGroup } from './schema.ts';

// Total context.md byte budget. Once an append would exceed it, the OLDEST whole-group blocks are
// dropped first — a block is never split. A single block larger than the cap is kept alone (the cap
// bounds accumulation across groups, it never truncates the newest block).
export const ROLLING_CONTEXT_MAX_BYTES = 8 * 1024;

// Blocks are separated by a blank line; a block's own lines are single-newline joined (no blank
// line inside), so splitting on "\n\n" round-trips the whole-block boundaries.
const BLOCK_SEPARATOR = '\n\n';

export type GroupDigestEntry = { group: PrGroup; pr: PullRequest; delivery: WorkerDelivery };

// Append one group's digest block to the existing context, then FIFO-cap the total.
export function appendGroupDigest(existing: string, entry: GroupDigestEntry): string {
  const block = renderBlock(entry);
  const combined = existing.trim() === '' ? block : `${existing}${BLOCK_SEPARATOR}${block}`;
  return capOldestFirst(combined);
}

function renderBlock({ group, pr, delivery }: GroupDigestEntry): string {
  return [
    `PR #${pr.number} — ${group.title} (group ${group.id}, branch ${delivery.branch})`,
    ...delivery.changes.map((c) => `- ${c.kind} ${c.path}: ${c.summary}`),
    ...delivery.progressEntries,
  ].join('\n');
}

// Drop oldest whole blocks until within budget, but always keep the newest block (even if it alone
// exceeds the cap — the cap bounds accumulation, never truncates the latest group).
function capOldestFirst(content: string): string {
  if (byteLength(content) <= ROLLING_CONTEXT_MAX_BYTES) return content;
  const blocks = content.split(BLOCK_SEPARATOR);
  while (
    blocks.length > 1 &&
    byteLength(blocks.join(BLOCK_SEPARATOR)) > ROLLING_CONTEXT_MAX_BYTES
  ) {
    blocks.shift();
  }
  return blocks.join(BLOCK_SEPARATOR);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

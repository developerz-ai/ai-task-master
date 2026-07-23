// What counts as dirt in the shared checkout, and the refusal raised when starting a run would
// destroy work aitm did not create. Pure: parses `git status --porcelain` output — the git call
// itself lives in in-place-checkout.ts.
//
// aitm works directly in the repo checkout and hard-resets it between PR groups, so it cannot tell
// a user's in-progress edits from a crashed group's leftovers: both are just dirty paths. The
// distinction is WHEN. Once a run has taken the tree, the dirt is provably its own and gets
// cleaned. At entry it is not — the operator may have been mid-edit, or a prior run may have died
// there — so a run that cannot know refuses and lets the operator decide.

// aitm's own state dir lives inside the tree it cleans. It is the run's bookkeeping, never user
// work: neither dirt to refuse over nor junk to delete.
export const STATE_DIR = '.ai-task-master';

// Porcelain v1 rows (`XY PATH`) for work aitm did not put there.
export function dirtyEntries(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.slice(3).startsWith(STATE_DIR));
}

// Enough rows to recognize the work, few enough to stay readable when a whole build output is
// untracked.
const MAX_LISTED = 10;

// Thrown at run entry, never between groups. Typed so the loop can abort the RUN instead of
// recording it as one group's failure — every group would hit the same precondition.
export class DirtyWorkingTree extends Error {
  readonly entries: readonly string[];

  constructor(repoRoot: string, entries: readonly string[]) {
    super(refusalMessage(repoRoot, entries));
    this.name = 'DirtyWorkingTree';
    this.entries = entries;
  }
}

function refusalMessage(repoRoot: string, entries: readonly string[]): string {
  const listed = entries.slice(0, MAX_LISTED).map((entry) => `  ${entry.trim()}`);
  if (entries.length > MAX_LISTED) listed.push(`  … and ${entries.length - MAX_LISTED} more`);
  return [
    `Refusing to start: ${repoRoot} has uncommitted changes.`,
    ...listed,
    'aitm works directly in this checkout and hard-resets it between PR groups, so this work would be destroyed.',
    'Commit it, stash it (`git stash -u`), or re-run with --allow-dirty to discard it.',
  ].join('\n');
}

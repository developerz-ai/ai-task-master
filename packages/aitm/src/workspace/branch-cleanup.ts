// End-of-run tidy-up: return the operator to the base branch and delete the group branches whose
// work has already landed.
//
// InPlaceCheckout deliberately leaves HEAD on a group's branch when it releases the slot — the next
// group just switches to its own, and putting the base back between groups would be wasted work. At
// the END of a run nothing switches again, so the run finishes parked on the last group's branch
// with every group branch still present. Observed after a five-group run: `git branch` listing
// aitm/G1..G5 with HEAD on aitm/G5, none of them of any further use.
//
// Only branches whose group actually MERGED are deleted, and always with `-D`. `-d` is not an option
// here: aitm squash-merges, so a merged branch is not an ancestor of the base and git's own
// merged-check would refuse every one of them. The authority for "this landed" is the run state —
// aitm opened the PR and aitm merged it — not the commit graph.
//
// The remote branch goes too: aitm pushed it, aitm's PR merged it, and leaving it behind clutters
// the remote exactly as the local copy clutters `git branch`. It is best-effort — a repo with
// "automatically delete head branches" enabled has already removed it, and that failure is expected,
// not an error.
//
// docs/runtime.md (uses execa via runGit, never Bun.$)

import { runGit } from './git-exec.ts';

export type BranchCleanup = {
  // The branch HEAD ended on, when this moved it. Undefined when it was already elsewhere.
  switchedTo?: string;
  deleted: string[];
  // Branches left in place, with why — a blocked group's branch still holds the only copy of its work.
  kept: string[];
};

export type CleanupInput = {
  cwd: string;
  baseBranch: string;
  // Branch names of groups the run recorded as merged. Nothing else is ever deleted.
  mergedBranches: readonly string[];
  // Also drop the branch on `origin`. Default true — the PR that owned it is merged.
  deleteRemote?: boolean;
};

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const name = stdout.trim();
    return name === '' || name === 'HEAD' ? undefined : name;
  } catch {
    return undefined;
  }
}

// Best-effort throughout: this runs after the work is done and every PR is merged, so a git failure
// here must report itself and change nothing else about the run's outcome.
export async function cleanupMergedBranches(input: CleanupInput): Promise<BranchCleanup> {
  const { cwd, baseBranch, mergedBranches } = input;
  const result: BranchCleanup = { deleted: [], kept: [] };
  if (mergedBranches.length === 0) return result;

  const head = await currentBranch(cwd);
  // Deleting the branch you are standing on is impossible; move to the base first. If the switch
  // fails (dirty tree, missing base) nothing is deleted — a half-tidied repo is worse than an untidy
  // one.
  if (head !== undefined && mergedBranches.includes(head)) {
    try {
      await runGit(['checkout', baseBranch], { cwd });
      result.switchedTo = baseBranch;
    } catch {
      return { ...result, kept: [...mergedBranches] };
    }
  }
  for (const branch of mergedBranches) {
    if (input.deleteRemote !== false) {
      // Already gone (GitHub auto-delete) or never pushed — either way there is nothing to report.
      await runGit(['push', 'origin', '--delete', branch], { cwd }).catch(() => undefined);
    }
    try {
      await runGit(['branch', '-D', branch], { cwd });
      result.deleted.push(branch);
    } catch {
      result.kept.push(branch);
    }
  }
  return result;
}

// One human line, or '' when there was nothing to tidy. Silence is correct for a run that opened no
// PRs; a run that merged five groups should say what it removed.
export function cleanupSummary(cleanup: BranchCleanup): string {
  const parts: string[] = [];
  if (cleanup.switchedTo !== undefined) parts.push(`back on ${cleanup.switchedTo}`);
  if (cleanup.deleted.length > 0) {
    parts.push(
      `deleted ${cleanup.deleted.length} merged branch(es): ${cleanup.deleted.join(', ')}`,
    );
  }
  if (cleanup.kept.length > 0) parts.push(`kept ${cleanup.kept.join(', ')}`);
  return parts.length === 0 ? '' : `Cleanup: ${parts.join(' — ')}\n`;
}

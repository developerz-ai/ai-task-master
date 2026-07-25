// The repo's shape, distilled from the tracked-file list without an LLM call.
//
// A survey team's first cost is orientation: every scout that starts from zero spends its opening
// steps globbing the same directories to learn what the repo even is, and N scouts pay that N times.
// The tracked-file list already answers it — where the files actually are, weighted by count — so a
// pure fold over those paths hands every downstream agent (the scout lead, each scout, the Planner)
// the same map for free, and their steps go to reading code instead of finding it.
//
// Deterministic and process-free on purpose: the caller runs `git ls-files`, this module only folds
// the paths. That keeps the ranking/capping decisions unit-testable against a literal path list.

// Directory nesting kept in the map. Depth 3 is where the signal is: it separates
// `packages/aitm/src` from `packages/aitm/docs` on a monorepo and `src/subagents` from `src/loop` on
// a flat repo. Depth 4 doubles the map's size to name leaf folders a scout will open anyway.
export const SKELETON_MAX_DEPTH = 3;

// Render caps, applied per level so one crowded directory can't push the rest of the map out. Every
// truncation is rendered as `+N more`, never silently dropped — a scout must be able to tell "this
// is the whole repo" from "this is the top of a long list".
export const SKELETON_MAX_ROOT_FILES = 14;
export const SKELETON_MAX_TOP_DIRS = 12;
export const SKELETON_MAX_CHILD_DIRS = 8;
export const SKELETON_MAX_LEAF_DIRS = 8;

export type SkeletonDir = {
  // Full repo-relative path (`packages/aitm/src`) — what a scout passes straight to glob/grep.
  path: string;
  // Tracked files at or below this directory.
  files: number;
  children: SkeletonDir[];
};

export type RepoSkeleton = {
  totalFiles: number;
  // Repo-root files only. Manifests, lockfiles and style docs live here, so this line alone usually
  // identifies the toolchain.
  rootFiles: string[];
  // Top-level directories, ranked heaviest first.
  dirs: SkeletonDir[];
};

// Fold tracked paths into the ranked directory tree. Ordering is by file count descending, then path
// ascending — weight is the useful signal ("most of this repo is under packages/aitm/src") and the
// name tiebreak keeps the map stable across runs so a cached prompt prefix stays byte-identical.
export function buildRepoSkeleton(
  paths: readonly string[],
  maxDepth: number = SKELETON_MAX_DEPTH,
): RepoSkeleton {
  const rootFiles: string[] = [];
  const roots = new Map<string, MutableDir>();
  let totalFiles = 0;
  for (const raw of paths) {
    const path = raw.trim();
    if (path === '') continue;
    totalFiles += 1;
    const segments = path.split('/').filter((s) => s !== '');
    // `dir/` with no basename can't happen in ls-files output, but a stray trailing slash would
    // otherwise register the file as a directory of its own.
    if (segments.length <= 1) {
      rootFiles.push(path);
      continue;
    }
    // Every ancestor directory of the file, capped at maxDepth — the file itself is the last segment.
    const depth = Math.min(segments.length - 1, maxDepth);
    let level = roots;
    let prefix = '';
    for (let i = 0; i < depth; i += 1) {
      prefix = prefix === '' ? (segments[i] ?? '') : `${prefix}/${segments[i]}`;
      const existing = level.get(prefix);
      const node: MutableDir = existing ?? { path: prefix, files: 0, children: new Map() };
      node.files += 1;
      if (!existing) level.set(prefix, node);
      level = node.children;
    }
  }
  return {
    totalFiles,
    rootFiles: [...rootFiles].sort((a, b) => a.localeCompare(b)),
    dirs: freezeLevel(roots),
  };
}

// The map as the agents read it. Kept to a handful of lines: it rides in front of every scout prompt
// (and the Planner's brief), so an exhaustive tree would cost more context than the discovery it
// saves. Levels render differently by design — top and child directories carry their own line
// because that is where a scout picks its territory, leaf directories inline as a comma list because
// there they are a hint, not a choice.
export function renderRepoSkeleton(skeleton: RepoSkeleton): string {
  const lines = [`Repo map — ${skeleton.totalFiles} tracked file(s)`];
  if (skeleton.rootFiles.length > 0) {
    lines.push(`  root: ${joinCapped(skeleton.rootFiles, SKELETON_MAX_ROOT_FILES, 'more')}`);
  }
  const { kept: tops, dropped: droppedTops } = capDirs(skeleton.dirs, SKELETON_MAX_TOP_DIRS);
  for (const top of tops) {
    lines.push(`  ${dirLabel(top)}`);
    const { kept: children, dropped } = capDirs(top.children, SKELETON_MAX_CHILD_DIRS);
    for (const child of children) {
      const leaves = capDirs(child.children, SKELETON_MAX_LEAF_DIRS);
      const inline = leaves.kept.map((leaf) => `${basename(leaf.path)}/ (${leaf.files})`);
      if (leaves.dropped > 0) inline.push(`+${leaves.dropped} more`);
      const suffix = inline.length > 0 ? `: ${inline.join(', ')}` : '';
      lines.push(`    ${basename(child.path)}/ (${child.files})${suffix}`);
    }
    if (dropped > 0) lines.push(`    +${dropped} more dir(s)`);
  }
  if (droppedTops > 0) lines.push(`  +${droppedTops} more dir(s)`);
  return lines.join('\n');
}

type MutableDir = { path: string; files: number; children: Map<string, MutableDir> };

function freezeLevel(level: Map<string, MutableDir>): SkeletonDir[] {
  return [...level.values()]
    .map((dir) => ({ path: dir.path, files: dir.files, children: freezeLevel(dir.children) }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

function capDirs(
  dirs: readonly SkeletonDir[],
  limit: number,
): { kept: SkeletonDir[]; dropped: number } {
  return { kept: dirs.slice(0, limit), dropped: Math.max(0, dirs.length - limit) };
}

function dirLabel(dir: SkeletonDir): string {
  return `${dir.path}/ (${dir.files})`;
}

function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function joinCapped(items: readonly string[], limit: number, noun: string): string {
  const kept = items.slice(0, limit).join(', ');
  const dropped = items.length - limit;
  return dropped > 0 ? `${kept} (+${dropped} ${noun})` : kept;
}

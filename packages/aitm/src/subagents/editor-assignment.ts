// Who owns which files in the editor fanout — the Coordinator's call, not a grouping rule's.
//
// The fanout used to split a manifest by parent directory: files under `src/auth/` went to one leaf,
// `src/routes/` to another, and any directory over MAX_FILES_PER_EDITOR was chunked to size. That is
// a proxy for cohesion, and it is wrong exactly when it matters — a route, its service and its test
// live in three directories and belong to ONE editor, while two unrelated modules under `src/lib/`
// are two editors' work regardless of sharing a parent.
//
// The Coordinator already knows the real answer. It surveyed the repo and wrote the manifest, so it
// is the lead here — there is nothing for a separate lead agent to re-derive. It expresses the split
// by tagging each manifest entry with the teammate that owns it (`editor`), the same way the scout
// lead sizes its own wave: as many editors as the work genuinely divides into, and one is a fine
// answer.
//
// SRP: this module turns manifest entries into per-leaf groups and nothing else. The fallback for an
// untagged manifest (directory grouping) lives here too, since it is the same decision made without
// the lead's input.

import type { FileManifestEntry } from './worker.ts';

// A manifest entry's grouping key when no editor was named: its immediate parent directory (POSIX
// manifest paths), or '.' for a repo-root file.
export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

// One leaf's assignment: the files it owns, plus the name the lead gave it (absent when the grouping
// fell back to directories — the fanout labels those itself, from the paths).
export type EditorAssignment = { editor?: string; files: FileManifestEntry[] };

// Group manifest entries into per-leaf assignments: entries sharing a parent directory go to the same
// leaf, and a directory with more than `maxPerGroup` entries is chunked to that size so no single leaf
// owns an unbounded brief while a large directory still spreads across the pool. Manifest order is
// preserved within and across groups so the fanout — and its tests — stay deterministic. A single-entry
// manifest yields one single-entry group, keeping that path byte-identical to the pre-team fanout.
export function groupManifestByDir(
  files: readonly FileManifestEntry[],
  maxPerGroup: number,
): FileManifestEntry[][] {
  const byDir = new Map<string, FileManifestEntry[]>();
  for (const file of files) {
    const dir = dirOf(file.path);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(file);
    else byDir.set(dir, [file]);
  }
  const size = Math.max(1, Math.floor(maxPerGroup) || 1);
  const groups: FileManifestEntry[][] = [];
  for (const bucket of byDir.values()) {
    for (let i = 0; i < bucket.length; i += size) {
      groups.push(bucket.slice(i, i + size));
    }
  }
  return groups;
}

// Split the manifest the way the Coordinator asked for, falling back to directory grouping for the
// part it left unassigned.
//
// A tagged group is honored WHOLE — never chunked at maxPerGroup, unlike the directory fallback. The
// cap exists to stop a mechanical rule from handing one leaf an incoherent pile; when the lead named
// the group, the pile is the point, and an editor is not rationed: it reads and writes as much as the
// assignment needs. Splitting a deliberate 9-file assignment into two leaves would hand half a
// feature to an editor that cannot see the other half — the exact failure the tag exists to prevent.
//
// Groups come back in first-appearance order of their tag, so the roster reads in the order the
// Coordinator wrote the manifest. Untagged entries are grouped by directory and appended after.
export function assignEditors(
  files: readonly FileManifestEntry[],
  maxPerGroup: number,
): EditorAssignment[] {
  const byEditor = new Map<string, FileManifestEntry[]>();
  const untagged: FileManifestEntry[] = [];
  for (const file of files) {
    const editor = file.editor?.trim();
    if (!editor) {
      untagged.push(file);
      continue;
    }
    const bucket = byEditor.get(editor);
    if (bucket) bucket.push(file);
    else byEditor.set(editor, [file]);
  }
  const assigned: EditorAssignment[] = [...byEditor].map(([editor, group]) => ({
    editor,
    files: group,
  }));
  const fallback = groupManifestByDir(untagged, maxPerGroup).map((group) => ({ files: group }));
  return [...assigned, ...fallback];
}

// Who owns which files in the editor fanout — the Coordinator's call, and only its call.
//
// This used to split a manifest by parent directory, chunked at a per-leaf cap. That is a proxy for
// cohesion and it is wrong exactly when it matters: a route, its service and its test live in three
// directories and belong to ONE editor, while two unrelated modules under `src/lib/` are two
// editors' work regardless of sharing a parent. The Coordinator surveyed the repo and wrote the
// manifest, so it already knows the real answer — it says so by tagging each entry with the
// teammate that owns it.
//
// There is no directory fallback for an untagged manifest. That rule is the design the tag replaced,
// and reviving it whenever the model omits the field would mean the replaced behaviour runs on the
// exact path nobody exercises deliberately (house style: no legacy). An untagged manifest is a
// Coordinator that did not divide the work, so it is not divided: one editor owns it. That reads the
// same way the rest of the harness does — a subagent is not rationed, so a big single assignment is
// a normal outcome, not a degraded one.
//
// SRP: this module turns manifest entries into per-leaf groups and nothing else.

import type { FileManifestEntry } from './worker.ts';

// One leaf's assignment: the files it owns, plus the name the lead gave it. `editor` is absent only
// for the unassigned remainder, which the fanout labels from the paths instead.
export type EditorAssignment = { editor?: string; files: FileManifestEntry[] };

// Split the manifest the way the Coordinator asked for.
//
// A tagged group is honored WHOLE — never chunked at a size cap. A cap exists to stop a mechanical
// rule from handing one leaf an incoherent pile; when the lead named the group, the pile is the
// point, and an editor reads and writes as much as its assignment needs. Splitting a deliberate
// 9-file assignment would hand half a feature to an editor that cannot see the other half — the
// exact failure the tag exists to prevent.
//
// Groups come back in first-appearance order of their tag, so the roster reads in the order the
// Coordinator wrote the manifest. Anything it left untagged is one final group: undivided work, one
// owner.
export function assignEditors(files: readonly FileManifestEntry[]): EditorAssignment[] {
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
  return untagged.length > 0 ? [...assigned, { files: untagged }] : assigned;
}

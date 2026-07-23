// String-replace edit tools, modeled on Claude Code's Edit. `editFile` does one exact replacement;
// `multiEdit` applies a sequence atomically (all succeed and the file is written once, or nothing
// is written). Both reject an `oldString` that is absent or — unless `replaceAll` — ambiguous, and
// (issue #104) enforce the file-state contract: the file must have been Read this run and not have
// changed on disk since; identical old/new strings are rejected; a numbered snippet of the edited
// region rides the result so the model can self-verify without a re-read. Writes are atomic.

import { readFile as fsReadFile } from 'node:fs/promises';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { atomicWriteFile } from './atomic-write.ts';
import { findFuzzyMatch, isDisproportionateMatch } from './edit-replacers.ts';
import { type FileStateTracker, hashContent } from './file-state.ts';
import type { FileToolInit } from './fs-tools.ts';
import { resolveInside } from './safe-path.ts';

const editSpecSchema = z.object({
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});
const editFileInputSchema = z.object({ path: z.string().min(1) }).extend(editSpecSchema.shape);
const multiEditInputSchema = z.object({
  path: z.string().min(1),
  edits: z.array(editSpecSchema).min(1),
});

// Input types derived from the schemas so they match `tool()`'s inference exactly (the AI SDK's
// Schema<T> is invariant; hand-written optionals won't unify with Zod's `T | undefined`).
export type EditSpec = z.infer<typeof editSpecSchema>;
export type EditFileInput = z.infer<typeof editFileInputSchema>;
export type EditFileOutput = { ok: boolean; replacements: number; snippet: string };
export type MultiEditInput = z.infer<typeof multiEditInputSchema>;
export type MultiEditOutput = { ok: boolean; replacements: number; snippet: string };

const MAX_LINE_CHARS = 2000;
const SNIPPET_CONTEXT_LINES = 4;

export function editFileTool(init: FileToolInit): Tool<EditFileInput, EditFileOutput> {
  return tool({
    description:
      'Edit a file in the worktree by exact string replacement. You must Read the file earlier in this run first, or the call fails; if the file changed on disk since your Read, re-read it before editing. Strip the line-number prefix from Read output when building `oldString`. `oldString` must occur exactly once unless `replaceAll` is true. The result includes a `cat -n` numbered snippet of the edited region — do not re-read the file just to verify.',
    inputSchema: editFileInputSchema,
    execute: async (input: EditFileInput): Promise<EditFileOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      const original = await readForEdit(init.fileState, safe, input.path);
      const { next, count } = applyEdit(original, input);
      await atomicWriteFile(safe, next);
      init.fileState.record(safe, hashContent(next), 'edit');
      return { ok: true, replacements: count, snippet: editSnippet(original, next) };
    },
    // Plain-text confirmation + the numbered snippet, not a JSON envelope (issue #127).
    toModelOutput: ({ input, output }) => ({
      type: 'text',
      value: renderEditOutput(input.path, output),
    }),
  });
}

export function multiEditTool(init: FileToolInit): Tool<MultiEditInput, MultiEditOutput> {
  return tool({
    description:
      'Apply a sequence of exact string replacements to a single file atomically. You must Read the file earlier in this run first, or the call fails; re-read if it changed on disk since. Strip the line-number prefix from Read output when building each `oldString`. Edits apply in order to the in-memory contents; if any fails (string absent, ambiguous, or identical to its replacement), nothing is written. The result includes a numbered snippet of the edited region.',
    inputSchema: multiEditInputSchema,
    execute: async (input: MultiEditInput): Promise<MultiEditOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      const original = await readForEdit(init.fileState, safe, input.path);
      let content = original;
      let total = 0;
      input.edits.forEach((edit, i) => {
        try {
          const { next, count } = applyEdit(content, edit);
          content = next;
          total += count;
        } catch (err) {
          throw new Error(`edit ${i + 1}/${input.edits.length}: ${(err as Error).message}`);
        }
      });
      await atomicWriteFile(safe, content);
      init.fileState.record(safe, hashContent(content), 'edit');
      return { ok: true, replacements: total, snippet: editSnippet(original, content) };
    },
    toModelOutput: ({ input, output }) => ({
      type: 'text',
      value: renderEditOutput(input.path, output),
    }),
  });
}

// Shared plain-text rendering for editFile/multiEdit (issue #127): a confirmation line carrying the
// replacement count, followed by the numbered snippet of the edited region verbatim.
function renderEditOutput(path: string, output: { replacements: number; snippet: string }): string {
  const noun = output.replacements === 1 ? 'replacement' : 'replacements';
  return `Applied ${output.replacements} ${noun} to ${path}.\n${output.snippet}`;
}

// Enforce the read-before-edit + not-stale contract, returning the on-disk content to edit against.
async function readForEdit(
  fileState: FileStateTracker,
  safe: string,
  displayPath: string,
): Promise<string> {
  if (!fileState.hasSeen(safe)) {
    throw new Error(
      `Refusing to edit ${displayPath}: it was not Read this run. Read it first, then Edit.`,
    );
  }
  let content: string;
  try {
    content = await fsReadFile(safe, 'utf8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      throw new Error(`Cannot edit ${displayPath}: file not found (was it deleted?).`);
    }
    throw err;
  }
  if (fileState.isStale(safe, hashContent(content))) {
    throw new Error(`${displayPath} was modified since you read it — re-read it before editing.`);
  }
  return content;
}

// Pure string replacement with the uniqueness contract. Uses split/join so `newString` is
// inserted verbatim (no `$&`/`$1` substitution that String.prototype.replace would apply).
export function applyEdit(content: string, edit: EditSpec): { next: string; count: number } {
  // Guard the exported API: the tool schemas enforce min(1), but a direct caller could pass
  // '' — which `split('')` would treat as a match at every character boundary.
  if (edit.oldString.length === 0) {
    throw new Error('oldString must be non-empty');
  }
  // A paid-for no-op — reject before touching the file (issue #104).
  if (edit.oldString === edit.newString) {
    throw new Error('oldString and newString are identical — the edit would change nothing');
  }
  // Exact match always wins (byte-identical to the pre-#268 path).
  if (content.split(edit.oldString).length - 1 >= 1) {
    return replaceSpan(content, edit.oldString, edit.newString, edit.replaceAll ?? false);
  }
  // Exact miss — fall back to a guarded fuzzy match (issue #268). The ladder runs only on zero exact
  // hits. A whitespace-only `oldString` is never fuzzed: its trimmed form matches every blank line and
  // would yield an empty span that `replaceSpan` would splice between every character. The located
  // span is refused if it is disproportionately larger than `oldString`, or if the chosen matcher
  // found more than one candidate without `replaceAll` — the same uniqueness contract as the exact
  // path — so fuzzy never clobbers.
  const fuzzy = edit.oldString.trim() === '' ? undefined : findFuzzyMatch(content, edit.oldString);
  if (fuzzy === undefined) {
    throw new Error(`oldString not found: ${preview(edit.oldString)}`);
  }
  if (isDisproportionateMatch(fuzzy.span, edit.oldString)) {
    throw new Error(
      `fuzzy match refused — the located span is much larger than oldString (${preview(edit.oldString)}); re-read the file and pass the exact text to replace`,
    );
  }
  if (fuzzy.count > 1 && !(edit.replaceAll ?? false)) {
    throw new Error(
      `oldString is not unique (${fuzzy.count} fuzzy matches): ${preview(edit.oldString)} — add surrounding context or pass replaceAll`,
    );
  }
  return replaceSpan(content, fuzzy.span, edit.newString, edit.replaceAll ?? false);
}

// Apply a replacement of an exact `target` span under the uniqueness contract: >1 occurrence
// without `replaceAll` is rejected. Shared by the exact and fuzzy-fallback paths of `applyEdit`.
function replaceSpan(
  content: string,
  target: string,
  newString: string,
  replaceAll: boolean,
): { next: string; count: number } {
  const occurrences = content.split(target).length - 1;
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `oldString is not unique (${occurrences} matches): ${preview(target)} — add surrounding context or pass replaceAll`,
    );
  }
  if (replaceAll) {
    return { next: content.split(target).join(newString), count: occurrences };
  }
  const at = content.indexOf(target);
  const next = content.slice(0, at) + newString + content.slice(at + target.length);
  return { next, count: 1 };
}

// A `cat -n` numbered window of the edited file centered on the first line that changed, so the
// model can confirm the edit landed without a follow-up Read.
function editSnippet(before: string, after: string): string {
  const around = firstDiffLine(before, after);
  const lines = after.split('\n');
  const start = Math.max(0, around - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, around + SNIPPET_CONTEXT_LINES + 1);
  return lines
    .slice(start, end)
    .map((line, i) => `${start + i + 1}\t${truncateLine(line)}`)
    .join('\n');
}

// The 0-based index of the first line that differs between two versions (or the last common line
// when one is a strict prefix of the other).
function firstDiffLine(before: string, after: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return Math.max(0, n - 1);
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

function preview(s: string): string {
  const oneLine = s.replace(/\n/g, '\\n');
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

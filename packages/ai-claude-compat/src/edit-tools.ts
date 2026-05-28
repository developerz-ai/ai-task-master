// String-replace edit tools, modeled on Claude Code's Edit. `editFile` does one exact
// replacement; `multiEdit` applies a sequence atomically (all succeed and the file is written
// once, or nothing is written). Both reject an `oldString` that is absent or — unless
// `replaceAll` — ambiguous, so the model can't silently edit the wrong occurrence.

import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { type Tool, tool } from 'ai';
import { z } from 'zod';
import type { ToolInit } from './fs-tools.ts';
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
export type EditFileOutput = { ok: boolean; replacements: number };
export type MultiEditInput = z.infer<typeof multiEditInputSchema>;
export type MultiEditOutput = { ok: boolean; replacements: number };

export function editFileTool(init: ToolInit): Tool<EditFileInput, EditFileOutput> {
  return tool({
    description:
      'Edit a file in the worktree by exact string replacement. `oldString` must occur exactly once unless `replaceAll` is true (then every occurrence is replaced). Errors if `oldString` is not found, or is ambiguous without `replaceAll`.',
    inputSchema: editFileInputSchema,
    execute: async (input: EditFileInput): Promise<EditFileOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      const original = await fsReadFile(safe, 'utf8');
      const { next, count } = applyEdit(original, input);
      await fsWriteFile(safe, next, 'utf8');
      return { ok: true, replacements: count };
    },
  });
}

export function multiEditTool(init: ToolInit): Tool<MultiEditInput, MultiEditOutput> {
  return tool({
    description:
      'Apply a sequence of exact string replacements to a single file atomically. Edits apply in order to the in-memory contents; if any edit fails (string absent or ambiguous), nothing is written. Use for several related edits to the same file.',
    inputSchema: multiEditInputSchema,
    execute: async (input: MultiEditInput): Promise<MultiEditOutput> => {
      const safe = await resolveInside(init.cwd, input.path);
      let content = await fsReadFile(safe, 'utf8');
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
      await fsWriteFile(safe, content, 'utf8');
      return { ok: true, replacements: total };
    },
  });
}

// Pure string replacement with the uniqueness contract. Uses split/join so `newString` is
// inserted verbatim (no `$&`/`$1` substitution that String.prototype.replace would apply).
export function applyEdit(content: string, edit: EditSpec): { next: string; count: number } {
  // Guard the exported API: the tool schemas enforce min(1), but a direct caller could pass
  // '' — which `split('')` would treat as a match at every character boundary.
  if (edit.oldString.length === 0) {
    throw new Error('oldString must be non-empty');
  }
  const occurrences = content.split(edit.oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`oldString not found: ${preview(edit.oldString)}`);
  }
  if (occurrences > 1 && !edit.replaceAll) {
    throw new Error(
      `oldString is not unique (${occurrences} matches): ${preview(edit.oldString)} — add surrounding context or pass replaceAll`,
    );
  }
  if (edit.replaceAll) {
    return { next: content.split(edit.oldString).join(edit.newString), count: occurrences };
  }
  const at = content.indexOf(edit.oldString);
  const next = content.slice(0, at) + edit.newString + content.slice(at + edit.oldString.length);
  return { next, count: 1 };
}

function preview(s: string): string {
  const oneLine = s.replace(/\n/g, '\\n');
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

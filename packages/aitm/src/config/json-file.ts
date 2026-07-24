// Shared JSON config-file I/O for the config surfaces (ConfigWriter, ProfileManager, ConfigLoader).
// Each reads ~/.aitm.json or a project config.json the same way: a missing file is empty (never an
// error — the first `config set`/`profile add` writes it into being), malformed JSON is a hard error
// naming the path, and the dotted-path writers additionally require a top-level object.
// formatZodError renders a schema failure as a compact one-liner for the CLI.

import { readFile } from 'node:fs/promises';
import type { ZodError } from 'zod';

// ENOENT — the config file simply doesn't exist yet. Every reader treats this as "empty".
export function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

export function formatZodError(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

// Read + JSON.parse a file. Missing file → undefined (JSON has no `undefined`, so it is an
// unambiguous "not found" sentinel distinct from a file whose content is `null`). Malformed JSON
// throws with the path so the failure is diagnosable.
export async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: invalid JSON — ${msg}`);
  }
}

// Like readJsonFile, but the mutating surfaces (ConfigWriter, ProfileManager) edit a top-level
// object: a missing file is an empty object and a non-object top level is rejected.
export async function readJsonObjectFile(path: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonFile(path);
  if (parsed === undefined) return {};
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object at the top level`);
  }
  return parsed as Record<string, unknown>;
}

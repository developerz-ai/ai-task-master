// Confine a requested path to a root directory. Every FS tool in this lib is exposed to a
// fallible LLM and may run against the user's real repo (not a sandbox), so a missing path
// check is an arbitrary read/write primitive — same severity as a path-traversal CVE in a web
// app. The guard uses two layers: (1) a cheap pre-resolve string check via `path.relative`
// that rejects `../`-style escapes, and (2) a realpath of the closest existing ancestor that
// defeats symlink trickery. We can't realpath the target itself (it may not exist yet for a
// write), so we realpath the parent and re-check the relative path from there.

import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

// Resolve `requested` against `root` and assert the result stays inside `root`. Accepts a
// relative path (resolved against root) or an absolute path (must still be inside root).
// Throws if the path escapes, by string or via symlink.
export async function resolveInside(root: string, requested: string): Promise<string> {
  const absRoot = resolve(root);
  const target = isAbsolute(requested) ? resolve(requested) : resolve(absRoot, requested);
  if (escapesRoot(absRoot, target)) {
    throw new Error(`path escapes worktree: ${requested}`);
  }
  const realRoot = await safeRealpath(absRoot);
  const realTarget = await realpathOfExisting(target);
  if (escapesRoot(realRoot, realTarget)) {
    throw new Error(`path escapes worktree via symlink: ${requested}`);
  }
  return target;
}

function escapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return false;
  if (rel.startsWith('..')) return true;
  if (isAbsolute(rel)) return true;
  return false;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

// Walk up `target`'s ancestors until one exists, realpath it, then re-attach the
// non-existing suffix. Lets us safely check would-be-created paths.
async function realpathOfExisting(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = dirname(target);
    if (parent === target) return target;
    const realParent = await realpathOfExisting(parent);
    const suffix = relative(parent, target);
    return resolve(realParent, suffix);
  }
}

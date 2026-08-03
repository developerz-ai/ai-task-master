// On-touch delivery of nested CLAUDE.md/AGENTS.md files (issue #192).
//
// #117 shipped nested discovery EAGERLY: every nested file in the repo was concatenated into the
// style digest up front, under a 64KiB budget that dropped whatever came after it. In a monorepo
// that spends the budget on subtrees the run never opens, and silently drops the one it does.
//
// The real harness loads a nested directory's instructions only when a file in that subtree is
// touched. This builds the same behaviour on the #106 system-reminder channel: the file tools carry
// a provider that, on each call, announces any nested file governing the path just touched.
//
// Announced ONCE per file per tool set. A tool set is one subagent invocation, so a later Worker on
// the same subtree is told again — correct, since it has its own context and never saw the first.

import { relative, resolve, sep } from 'node:path';
import type { ReminderProvider } from '@developerz.ai/ai-claude-compat';
import type { NestedConfig } from './agent-config-detector.ts';

// The file tools all take a `path`. That path IS the touch — reading it out of the completed call is
// more direct than re-deriving it from the tracker's accumulated set, and it keeps the tracker
// private to the tool set that owns it.
function touchedPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const path = (input as { path?: unknown }).path;
  return typeof path === 'string' && path !== '' ? path : null;
}

// True when `file` lies inside `dir` — including `dir` itself. Compared on resolved paths with a
// trailing separator so `/repo/apps` does not match `/repo/apps-legacy`.
function inSubtree(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
}

// A reminder provider that announces each nested file the first time the run touches its subtree.
// Empty `nested` → a provider that never fires; callers skip decoration entirely in that case, so
// a repo without nested files is byte-identical to before.
export function nestedConfigReminders(
  nested: readonly NestedConfig[],
  cwd: string,
): ReminderProvider {
  const announced = new Set<string>();
  return ({ input }) => {
    const touched = touchedPath(input);
    if (touched === null) return [];
    const abs = resolve(cwd, touched);
    const due = nested.filter((n) => !announced.has(n.path) && inSubtree(n.dir, abs));
    if (due.length === 0) return [];
    for (const n of due) announced.add(n.path);
    return due.map((n) => nestedConfigBlock(n, cwd));
  };
}

// One announcement. Framed like the first-message `claudeMd` context section so the model reads it
// as the same kind of thing: repo instructions that apply here, not a warning about its last call.
export function nestedConfigBlock(nested: NestedConfig, cwd: string): string {
  const dir = relative(cwd, nested.dir) || '.';
  return [
    `Contents of ${relative(cwd, nested.path)} (instructions for files under ${dir}/, loaded because you just touched one):`,
    '',
    nested.contents,
  ].join('\n');
}

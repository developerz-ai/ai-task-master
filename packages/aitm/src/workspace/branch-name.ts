// Git ref-component naming for aitm branches. Shared by the run-loop adapter (group branch names)
// and the WorkLoop (per-task branch names in prPerTask mode). Extracted here once the WorkLoop
// became a second real caller of the sanitizer — one home for "make this string a valid ref part".

// Normalize an arbitrary id into a safe single git ref component. Ids can carry characters (leading
// '.', '.lock', spaces, ':' …) that would make a composed ref invalid and fail at checkout/worktree
// creation. Map unsafe chars to '-', strip the component-level footguns, never return empty.
export function sanitizeBranchComponent(id: string): string {
  let s = id.replace(/[^A-Za-z0-9._-]/g, '-');
  s = s.replace(/\.\.+/g, '.'); // collapse '..' (forbidden in refs)
  s = s.replace(/^[.-]+/, ''); // no leading '.' or '-'
  s = s.replace(/(?:\.lock)+$/i, ''); // no trailing '.lock'
  s = s.replace(/[.-]+$/, ''); // no trailing '.' or '-'
  return s.length > 0 ? s : 'group';
}

// A per-task branch derived from the group branch: `<groupBranch>-<safe(taskId)>`. prPerTask +
// autoMerge gives every task its own branch off the freshly-merged base so each task's PR carries
// only that task's changes. A '-' separator (NOT '/') keeps it a SIBLING of the group branch rather
// than a child: git stores refs as files, so a branch `aitm/g1` and a nested `aitm/g1/t2` cannot
// coexist ("cannot lock ref … exists"), but `aitm/g1` and `aitm/g1-t2` can. The group branch is
// already ref-safe (built via branchFor); the task-id segment is sanitized because task ids are raw
// planner-derived strings, not guaranteed ref-safe.
export function perTaskBranch(groupBranch: string, taskId: string): string {
  return `${groupBranch}-${sanitizeBranchComponent(taskId)}`;
}

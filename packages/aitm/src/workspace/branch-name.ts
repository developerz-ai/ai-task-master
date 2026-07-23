// Git ref-component naming for aitm branches. Shared by the run-loop adapter (group branch names)
// and the WorkLoop (per-task branch names in prPerTask mode). Extracted here once the WorkLoop
// became a second real caller of the sanitizer — one home for "make this string a valid ref part".

// Normalize an arbitrary id into a safe single git ref component. Ids can carry characters (leading
// '.', '.lock', spaces, ':' …) that would make a composed ref invalid and fail at branch
// creation. Map unsafe chars to '-', strip the component-level footguns, never return empty.
export function sanitizeBranchComponent(id: string): string {
  let s = id.replace(/[^A-Za-z0-9._-]/g, '-');
  s = s.replace(/\.\.+/g, '.'); // collapse '..' (forbidden in refs)
  s = s.replace(/^[.-]+/, ''); // no leading '.' or '-'
  s = s.replace(/(?:\.lock)+$/i, ''); // no trailing '.lock'
  s = s.replace(/[.-]+$/, ''); // no trailing '.' or '-'
  return s.length > 0 ? s : 'group';
}

// Longest title slug appended to a group branch. Long enough to identify the group at a glance in
// `git branch` / the PR list, short enough that the composed ref stays readable and well under
// git's ref length limits once a `--branch` prefix and a per-task suffix are added.
const SLUG_MAX_CHARS = 40;

// A human-readable slug of a group title, for composing `aitm/<id>-<slug>` branch names: lowercase,
// words joined by '-', truncated at a word boundary. Returns '' when the title carries no usable
// characters — callers fall back to the id alone rather than emitting a trailing '-'.
export function slugifyTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
  const kept: string[] = [];
  let length = 0;
  for (const word of words) {
    const next = length === 0 ? word.length : length + 1 + word.length;
    if (kept.length > 0 && next > SLUG_MAX_CHARS) break;
    kept.push(word);
    length = next;
  }
  return kept.join('-').slice(0, SLUG_MAX_CHARS).replace(/-+$/, '');
}

// Resolve a run's desired branch names to names nobody has published yet. Two people running aitm
// on the same repo toward the same goal get the same plan, hence the same `aitm/<id>-<slug>` names —
// and force-push is allowed by default, so the second run would rewrite the first one's work on a
// branch it believes is its own. Each desired name is checked against `taken` (the remote's branches)
// AND against the names already handed out in this call — a run's own groups can collide with each
// other — falling back to `<name>-2`, `-3`, … until one is free.
//
// Pure: the caller supplies the remote's branch set (and degrades to an empty set when the remote
// can't be read, which yields the plain names). Returns exactly one name per input, in input order.
export function dedupeBranchNames(
  desired: readonly string[],
  taken: ReadonlySet<string>,
): string[] {
  const used = new Set(taken);
  const resolved: string[] = [];
  for (const name of desired) {
    let candidate = name;
    for (let suffix = 2; used.has(candidate); suffix += 1) {
      candidate = `${name}-${suffix}`;
    }
    used.add(candidate);
    resolved.push(candidate);
  }
  return resolved;
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

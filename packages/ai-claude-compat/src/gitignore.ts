// Minimal .gitignore matcher for the portable search walk (issue #110). Supports the common
// subset only: blank lines and `#` comments are ignored; `*` and `?` glob wildcards (neither
// crosses `/`); a trailing `/` restricts a rule to directories; a leading `/`, or any `/` inside
// the pattern, anchors it to the directory containing the .gitignore (otherwise a rule matches by
// basename at any depth beneath that directory). `!` negation is deliberately NOT supported — a
// negated line is dropped, documented here so a repo relying on re-inclusion is not silently
// surprised. `.git` / `node_modules` are skipped by the walker unconditionally, independent of this.

const GLOB_META = new Set(['.', '+', '^', '$', '(', ')', '|', '[', ']', '\\', '{', '}']);

export type GitignoreRule = {
  re: RegExp;
  // Directory-only rules (trailing `/`) match a directory entry, never a plain file.
  dirOnly: boolean;
};

// Translate one .gitignore glob body (no anchors, no trailing slash) to a regex fragment. `*` and
// `?` stay within a path segment; every other regex metacharacter is escaped to a literal.
function bodyToRegex(pattern: string): string {
  let re = '';
  for (const c of pattern) {
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (GLOB_META.has(c)) re += `\\${c}`;
    else re += c;
  }
  return re;
}

function compileRule(raw: string): GitignoreRule | null {
  // Leading whitespace is not significant in the common case; trailing spaces are dropped (the
  // backslash-escape-to-keep-trailing-space corner of the spec is out of scope for this minimal matcher).
  let line = raw.replace(/^\s+/, '').replace(/\s+$/, '');
  if (line === '' || line.startsWith('#')) return null;
  if (line.startsWith('!')) return null; // negation unsupported — see module header

  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  // A separator at the start or middle anchors the pattern to the .gitignore's directory; a bare
  // name (or `name/`) matches at any depth below it.
  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes('/')) {
    anchored = true;
  }
  if (line === '') return null;

  const prefix = anchored ? '^' : '(?:^|.*/)';
  // The `(?:/.*)?` tail makes a matched directory also cover everything beneath it, so ignoring
  // `dist/` prunes the whole subtree.
  return { re: new RegExp(`${prefix}${bodyToRegex(line)}(?:/.*)?$`), dirOnly };
}

// Parse a .gitignore file body into rules, preserving order. Unsupported / blank / comment lines
// are dropped.
export function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const raw of content.split('\n')) {
    const rule = compileRule(raw);
    if (rule) rules.push(rule);
  }
  return rules;
}

// Whether `relPath` (POSIX, relative to the directory holding these rules) is ignored. `isDir`
// gates directory-only rules. With no `!` negation, first match wins and short-circuits.
export function isIgnored(
  rules: readonly GitignoreRule[],
  relPath: string,
  isDir: boolean,
): boolean {
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.re.test(relPath)) return true;
  }
  return false;
}

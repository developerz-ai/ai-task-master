// Command deny/allow rules for the model-facing bash tool — a guardrail on the shell boundary, NOT
// a sandbox. It stops accidental destructive commands from a cooperative model (git push --force,
// gh pr merge, git reset --hard); it does NOT stop an adversarial payload. Tokenization is
// best-effort: a command can still evade via nested `bash -c`, `xargs`, a script on disk, or command
// substitution (`$(…)`/backticks are matched literally, not expanded). See issue #113.

export type CommandRule = { pattern: string; action: 'deny' | 'allow' };

// The verdict for a command: allowed to run, or denied by a specific rule pattern.
export type CommandDecision = { denied: false } | { denied: true; pattern: string };

// Evaluate a (possibly compound) command against the rules. Each subcommand is checked independently
// with first-match-wins over the rule list; a single denied subcommand denies the whole call. A
// command matching no rule runs (default-allow). There is no `ask` action — an unattended run has no
// user to ask, so ask degrades to `deny`.
export function evaluateCommand(command: string, rules: readonly CommandRule[]): CommandDecision {
  for (const sub of splitCompound(command)) {
    const tokens = skipCommandPrefixes(tokenize(sub));
    if (tokens.length === 0) continue;
    for (const rule of rules) {
      if (!matchesPattern(rule.pattern, tokens)) continue;
      if (rule.action === 'deny') return { denied: true, pattern: rule.pattern };
      break; // first match is an `allow` → this subcommand is cleared, skip the rest
    }
  }
  return { denied: false };
}

// Split a compound command into subcommands on `;`, `&&`, `||`, `|`, `&`, and newlines, respecting
// single/double quotes (an operator inside quotes is literal). Quote characters are preserved so the
// tokenizer can handle them.
function splitCompound(command: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// Split one subcommand into tokens on whitespace, treating a single/double-quoted span as one token
// (quotes stripped). Best-effort: nested quoting edge cases are not shell-exact.
function tokenize(subcommand: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | null = null;
  for (const ch of subcommand) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) {
        tokens.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

// Drop leading wrappers that don't change which real command runs, so a deny rule anchored on the
// real command still fires: `NAME=value` env-assignments (`GIT_TRACE=1 git push --force`) and the
// `env` / `command` builtins (`env git push --force`, `command git push --force`). Best-effort — an
// `env`/`command` invoked with its own option flags (`env -i git …`) is not fully unwrapped, per
// #113's guardrail-not-sandbox stance.
function skipCommandPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === 'env' || t === 'command') i++;
    else break;
  }
  return tokens.slice(i);
}

// A pattern (whitespace-split tokens, `*` a glob within one token) matches a subcommand when its
// first token matches the subcommand's first token (anchored) and its remaining tokens match a
// subsequence of the rest in order — so flag reordering can't evade (`git push origin main --force`
// matches `git push --force*`). Case-sensitive.
function matchesPattern(pattern: string, cmdTokens: string[]): boolean {
  const pat = pattern.split(/\s+/).filter((t) => t.length > 0);
  const first = pat[0];
  const cmdFirst = cmdTokens[0];
  if (first === undefined || cmdFirst === undefined) return false;
  // Anchor on the command's basename so an absolute/relative path can't evade a bare-name rule
  // (`/usr/bin/git push --force` matches a `git push …` pattern). Only the command token (index 0)
  // is normalized; argument paths keep their full value for the subsequence match.
  if (!tokenMatches(first, commandBasename(cmdFirst))) return false;
  let ci = 1;
  for (let pi = 1; pi < pat.length; pi++) {
    const pt = pat[pi] ?? '';
    let found = false;
    while (ci < cmdTokens.length) {
      const matched = tokenMatches(pt, cmdTokens[ci] ?? '');
      ci++;
      if (matched) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// One pattern token vs one command token. `*` globs any run of characters within the token; every
// other character is literal. No `*` → exact string equality.
function tokenMatches(patternToken: string, commandToken: string): boolean {
  if (!patternToken.includes('*')) return patternToken === commandToken;
  const re = new RegExp(`^${patternToken.split('*').map(escapeRegex).join('.*')}$`);
  return re.test(commandToken);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The last path segment of a command token: `/usr/bin/git` → `git`, `./git` → `git`, `git` → `git`.
function commandBasename(token: string): string {
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}
